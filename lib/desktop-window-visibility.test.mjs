import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isolatedEnvironment, stopProcess, waitUntil } from "../scripts/desktop-e2e/lifecycle.mjs";

const source = await readFile(new URL("../desktop/src/window-visibility.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const commonJs = { exports: {} };
vm.runInNewContext(compiled, { module: commonJs, exports: commonJs.exports });
const { configureWindowVisibility } = commonJs.exports;

test("Windows visibility configuration preserves other Chromium feature choices and is idempotent", () => {
  const switches = new Map([["disable-features", "ExistingFeature,AnotherFeature:mode/value"], ["enable-features", "EnabledFeature"]]);
  const changes = [];
  const commandLine = { getSwitchValue: key => switches.get(key) ?? "", appendSwitch: (key, value) => { changes.push([key, value]); switches.set(key, value); } };
  configureWindowVisibility(commandLine, "win32");
  configureWindowVisibility(commandLine, "win32");
  assert.deepEqual(changes, [["disable-features", "ExistingFeature,AnotherFeature:mode/value,CalculateNativeWinOcclusion"]]);
  assert.equal(switches.get("enable-features"), "EnabledFeature");
});

test("other desktop platforms keep their native visibility configuration", () => {
  const commandLine = { getSwitchValue: () => assert.fail("Must not read Windows switches"), appendSwitch: () => assert.fail("Must not alter other platforms") };
  for (const platform of ["darwin", "linux"]) configureWindowVisibility(commandLine, platform);
});

test("real Windows Electron hides, restores and resumes frame delivery without CDP visibility emulation", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async t => {
  await mkdir(resolve(".verification"), { recursive: true });
  const directory = await mkdtemp(resolve(".verification/window-visibility-regression-"));
  await writeFile(join(directory, "visibility.cjs"), compiled);
  const probe = async function () {
    // This function is serialized into the isolated Electron CommonJS entry.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { app, BrowserWindow } = require("electron");
    const assert = require("node:assert/strict");
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { configureWindowVisibility } = require("./visibility.cjs");
    /* eslint-enable @typescript-eslint/no-require-imports */
    app.setPath("userData", process.env.PIORA_DESKTOP_DEV_USER_DATA);
    configureWindowVisibility(app.commandLine, process.platform);
    const observations = [];
    try {
      await app.whenReady();
      const window = new BrowserWindow({ show: false, width: 900, height: 640, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true } });
      const document = '<title>Piora native visibility regression</title><h1>Visibility regression</h1><script>window.framesSeen=0;function draw(){framesSeen++;requestAnimationFrame(draw)}requestAnimationFrame(draw)</script><iframe sandbox="allow-scripts" srcdoc="<button>Child control</button>"></iframe>';
      await window.loadURL('data:text/html,' + encodeURIComponent(document));
      const sample = () => window.webContents.executeJavaScript('({hidden:document.hidden,visibility:document.visibilityState,frames:window.framesSeen})');
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const settled = async (action, hidden) => {
        const deadline = Date.now() + 5_000;
        let state;
        while (true) {
          state = await sample();
          if (state.hidden === hidden) break;
          assert.ok(Date.now() < deadline, `${action}: document visibility did not follow native state`);
          await delay(50);
        }
        await delay(250); const before = await sample();
        await delay(250); const after = await sample();
        const native = { visible: window.isVisible(), minimized: window.isMinimized() };
        observations.push({ action, native, before, after, backgroundThrottling: window.webContents.getBackgroundThrottling() });
        writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ versions: process.versions, observations }, null, 2));
        assert.equal(after.hidden, hidden, `${action}: visibility must stay settled`);
        assert.equal(after.visibility, hidden ? 'hidden' : 'visible');
        assert.equal(window.webContents.getBackgroundThrottling(), true, 'Background throttling must remain enabled');
        if (hidden) assert.equal(after.frames, before.frames, `${action}: hidden animation frames must stop`);
        else assert.ok(after.frames > before.frames, `${action}: restored controls must receive frames`);
      };
      window.show(); await settled('initial-show', false);
      for (let cycle = 0; cycle < 2; cycle++) {
        window.minimize(); await settled(`minimize-${cycle}`, true); assert.equal(window.isMinimized(), true);
        window.restore(); await settled(`restore-${cycle}`, false); assert.equal(window.isMinimized(), false);
        window.hide(); await settled(`hide-${cycle}`, true); assert.equal(window.isVisible(), false);
        window.show(); await settled(`show-${cycle}`, false); assert.equal(window.isVisible(), true);
      }
      window.destroy(); app.exit(0);
    } catch (error) {
      writeFileSync(join(__dirname, 'failure.json'), JSON.stringify({ error: error.stack, observations }, null, 2));
      console.error(error.stack); app.exit(1);
    }
  };
  const script = join(directory, "probe.cjs"); await writeFile(script, `(${probe.toString()})();\n`);
  const env = isolatedEnvironment(process.env, { profile: join(directory, "profile"), agent: join(directory, "agent"), port: 30141, debugPort: 0 });
  const child = spawn(createRequire(import.meta.url)("electron"), [script], { env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", outcome;
  child.stdout.on("data", data => { output = (output + data).slice(-10_000); });
  child.stderr.on("data", data => { output = (output + data).slice(-10_000); });
  const exited = new Promise(resolve => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", error => resolve({ error: error.message })); });
  void exited.then(value => { outcome = value; });
  t.after(() => stopProcess({ child, exited, outcome: () => outcome }));
  await waitUntil(() => outcome, { timeoutMs: 45_000, label: "isolated visibility regression exit" });
  await writeFile(join(directory, "electron.log"), output);
  assert.equal(outcome.code, 0, `${JSON.stringify(outcome)}; ${output}; evidence: ${directory}`);
  const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  assert.equal(result.observations.length, 9);
  t.diagnostic(`Native visibility evidence: ${directory}`);
});
