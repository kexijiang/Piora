import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("application proxy applies to shell, browser, updater and default sessions without closing live connections", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const source = ts.transpileModule(main.slice(main.indexOf("function parseDesktopNetworkProxySettings("), main.indexOf("function registerNetworkProxyHandler(")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const target = name => ({ setProxy: async config => { calls.push({ name, config }); }, closeAllConnections: () => { throw new Error("must preserve active traffic"); } });
  const shell = target("shell"), browser = target("browser"), updater = target("updater"), defaultSession = target("default");
  const apply = new Function("electronSession", "DESKTOP_PARTITION", "BROWSER_PARTITION", "autoUpdater", "logger", source + ";return applyDesktopNetworkProxy;")({
    defaultSession, fromPartition: name => name === "shell" ? shell : browser,
  }, "shell", "browser", { netSession: updater }, { warn() {} });
  assert.equal(await apply({ mode: "manual", proxyUrl: "http://127.0.0.1:7890", bypass: "internal.test" }), true);
  assert.deepEqual(calls.map(({ name }) => name).sort(), ["browser", "default", "shell", "updater"]);
  for (const { config } of calls) {
    assert.equal(config.mode, "fixed_servers");
    assert.equal(config.proxyRules, "http://127.0.0.1:7890");
    assert.match(config.proxyBypassRules, /localhost,127\.0\.0\.1,\[::1\],internal.test/);
  }
  calls.length = 0;
  assert.equal(await apply({ mode: "direct", proxyUrl: "", bypass: "" }), true);
  assert.ok(calls.every(({ config }) => config.mode === "direct"));
});

test("applying desktop proxy settings preserves an in-flight startup script", {
  skip: process.platform !== "win32", timeout: 40000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-proxy-electron-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith("piora-proxy-electron-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const source = ts.transpileModule(main.slice(main.indexOf("function parseDesktopNetworkProxySettings("), main.indexOf("function registerNetworkProxyHandler(")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const probe = async function (source) {
    const assert = require("node:assert/strict");
    const { app, BrowserWindow, session } = require("electron");
    const { createServer } = require("node:http");
    const { join } = require("node:path");
    app.setPath("userData", join(__dirname, "user-data"));
    require("node:fs").mkdirSync(app.getPath("userData"), { recursive: true });
    app.on("window-all-closed", () => {});
    console.log("PROXY_WAITING_FOR_ELECTRON");
    await app.whenReady();
    const updater = session.fromPartition("proxy-updater-fixture");
    const apply = new Function("electronSession", "DESKTOP_PARTITION", "BROWSER_PARTITION", "autoUpdater", "logger", source + ";return applyDesktopNetworkProxy;")(session, "proxy-fixture", "proxy-browser-fixture", { netSession: updater }, { warn() {} });
    let scriptResponse, started;
    const server = createServer((request, response) => {
      if (request.url === "/lazy.js") {
        scriptResponse = response;
        response.setHeader("Content-Type", "application/javascript");
        response.write("// script is still arriving\n");
        started();
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end('<main>Application shell</main>');
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const window = new BrowserWindow({ show: false, webPreferences: { partition: "proxy-fixture", sandbox: true } });
    try {
      for (const settings of [
        { mode: "system", proxyUrl: "", bypass: "" },
        { mode: "direct", proxyUrl: "", bypass: "" },
        { mode: "manual", proxyUrl: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" },
      ]) {
        console.log("PROXY_SCENARIO " + settings.mode);
        await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
        const requested = new Promise(resolve => { started = resolve; });
        const loaded = window.webContents.executeJavaScript(`new Promise(resolve => {
          const script = document.createElement('script');
          script.onload = () => resolve(window.STARTUP_CHUNK_LOADED === true);
          script.onerror = () => resolve(false);
          script.src = '/lazy.js'; document.head.append(script);
        })`);
        await requested;
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(await apply(settings), true);
        for (const target of [session.defaultSession, session.fromPartition("proxy-fixture"), session.fromPartition("proxy-browser-fixture"), updater]) {
          if (settings.mode === "manual") assert.equal(await target.resolveProxy("https://target.invalid"), "PROXY 127.0.0.1:9");
          if (settings.mode === "direct") assert.equal(await target.resolveProxy("https://target.invalid"), "DIRECT");
        }
        console.log("PROXY_APPLIED");
        scriptResponse.end("window.STARTUP_CHUNK_LOADED = true;");
        assert.equal(await loaded, true, settings.mode + " must not abort a loading chunk");
      }
      console.log("PROXY_ASSERTIONS_PASSED");
    } finally {
      window.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
  await writeFile(join(root, "probe.cjs"), `(${probe.toString()})(${JSON.stringify(source)}).then(()=>require('electron').app.quit()).catch(error=>{console.error(error);require('electron').app.exit(1);});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [join(root, "probe.cjs")], { cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PROXY_ASSERTIONS_PASSED/);
});
