import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

test("Windows Electron reaches the local app after broken, skipped, legacy-navigation and stalled intros", {
  skip: process.platform !== "win32", timeout: 120000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-startup-electron-"));
  const userData = join(root, "user-data");
  await mkdir(userData);
  const shortPathScript = `$ProgressPreference='SilentlyContinue'; (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${userData.replaceAll("'", "''")}').ShortPath`;
  const shortUserData = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(shortPathScript, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }).trim();
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith("piora-startup-electron-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const startup = compile(main.slice(main.indexOf("function createStartupWindow("), main.indexOf("type SmokeRendererState")));
  const application = compile(main.slice(main.indexOf("function loadApplicationWindow("), main.indexOf("function warmInitialModelCatalog(")));
  for (const name of ["startup-scene", "startup-tasks", "preload"]) {
    await writeFile(join(root, `${name}.cjs`), compile(await readFile(new URL(`../desktop/src/${name}.ts`, import.meta.url), "utf8")));
  }
  const probe = async function (startupSource, applicationSource) {
    const assert = require("node:assert/strict");
    const { app, BrowserWindow } = require("electron");
    const { join, resolve } = require("node:path");
    const { pathToFileURL } = require("node:url");
    const { writeFileSync, mkdirSync } = require("node:fs");
    const { createServer } = require("node:http");
    const scene = require("./startup-scene.cjs");
    const { runOptionalStartupTask } = require("./startup-tasks.cjs");
    app.setPath("userData", process.env.PIORA_TEST_USER_DATA);
    mkdirSync(app.getPath("userData"), { recursive: true });
    app.on("window-all-closed", () => {});
    await app.whenReady();
    const server = createServer((_req, response) => {
      // Leave enough time for a second video event during the handoff.
      setTimeout(() => { response.setHeader("Content-Type", "text/html"); response.end('<main id="healthy">LOCAL_APP_READY</main>'); }, 120);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    const log = { info() {}, warn() {}, error: (...args) => console.error(...args) };
    try {
      for (const scenario of ["invalid-media", "repeated-skip", "legacy-navigation", "stalled-file", "unwritable-file"]) {
        let window, readyEvents = 0, abortSeen = false;
        const bindings = {
          app, join, resolve, pathToFileURL, __dirname, process,
          ...scene, runOptionalStartupTask, PORTABLE_SMOKE_TEST: false,
          STARTUP_MEDIA_TIMEOUT_MS: scenario === "stalled-file" ? 80 : scene.STARTUP_MEDIA_TIMEOUT_MS,
          readLastLaunchedVersion: () => "previous-version",
          writeFileSync: (...args) => { if (scenario === "unwritable-file") throw new Error("EACCES startup.html"); writeFileSync(...args); },
          loadStartupMedia: () => scenario === "repeated-skip" ? {} : { video: "data:video/mp4;base64,AA==" },
          createStartupDocument: options => {
            const document = scene.createStartupDocument(options);
            // Trigger the exact old navigation explicitly. Waiting for a codec
            // error races the watchdog and varies across Windows images.
            if (scenario === "legacy-navigation") return document.replace("window.piDesktop?.finishStartupIntro()", "location.href='piora-startup://continue'")
              .replace("</body>", `<script nonce="piora-startup">location.href='piora-startup://continue';</script></body>`);
            if (scenario !== "repeated-skip") return document;
            return document.replace("</body>", `<script nonce="piora-startup">document.querySelector('#skip-intro').click();setTimeout(()=>document.querySelector('#skip-intro').click(),40);</script></body>`);
          },
          createMainWindowShell: () => {
            window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
            // Keep this automated regression invisible; ready-to-show remains real.
            window.show = () => { readyEvents++; };
            if (scenario === "stalled-file") window.loadFile = () => new Promise(() => {});
            window.webContents.on("will-navigate", (_event, target) => { if (target === "piora-startup://continue") abortSeen = true; });
            return { window, initialState: { maximized: false } };
          },
          isAllowedAppUrl: (candidate, origin) => new URL(candidate).origin === origin,
          openExternalUrl() {}, installNativeContextMenu() {},
        };
        const methods = new Function(...Object.keys(bindings), startupSource + applicationSource + ";return { createStartupWindow, loadApplicationWindow };")(...Object.values(bindings));
        {
          const startup = methods.createStartupWindow(log);
          await startup.finished;
          await methods.loadApplicationWindow(window, url, log);
          startup.ensureVisible();
          await startup.ready;
          assert.equal(await window.webContents.executeJavaScript("document.querySelector('#healthy')?.textContent"), "LOCAL_APP_READY", scenario);
          assert.equal(await window.webContents.executeJavaScript("typeof window.piDesktop.finishStartupIntro"), "function");
          assert.ok(readyEvents > 0, scenario + " must become visible");
          if (scenario === "legacy-navigation") assert.equal(abortSeen, true, "must exercise a blocked legacy continue navigation");
          assert.equal(window.webContents.getURL(), url.href);
          console.log("STARTUP_RECOVERED " + scenario);
        }
      }
    } finally {
      server.close(); server.closeAllConnections();
    }
    // The parent owns teardown of this hidden multi-window test process.
    console.log("STARTUP_ASSERTIONS_PASSED");
  };
  await writeFile(join(root, "probe.cjs"), `(${probe.toString()})(${JSON.stringify(startup)},${JSON.stringify(application)}).catch(error=>{console.log('STARTUP_ASSERTIONS_FAILED',String(error),error.stack)})`);
  const output = await new Promise((resolveOutput, reject) => {
    const env = { ...process.env, PIORA_TEST_USER_DATA: shortUserData }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [join(root, "probe.cjs")], { cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", passed = false;
    const stop = () => spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { stop(); reject(new Error("Startup recovery timed out:\n" + output)); }, 90000);
    child.stdout.on("data", data => {
      output += data;
      if (!passed && output.includes("STARTUP_ASSERTIONS_PASSED")) { passed = true; stop(); }
      else if (output.includes("STARTUP_ASSERTIONS_FAILED")) stop();
    }); child.stderr.on("data", data => { output += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (passed) resolveOutput(output); else reject(new Error(output || `Electron exited ${code}`)); });
  });
  for (const scenario of ["invalid-media", "repeated-skip", "legacy-navigation", "stalled-file", "unwritable-file"]) assert.ok(output.includes("STARTUP_RECOVERED " + scenario), output);
});
