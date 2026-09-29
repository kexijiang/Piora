import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": repo } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { createShell, getShell, listShells, ensureDefaultShell } = await jiti.import("./shell/registry.ts");
const { resolveNativeShellProfile, prepareShellLaunch } = await jiti.import("./shell/profiles.ts");
const { handleShellRequest } = await jiti.import("./shell/http.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

async function until(read, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Timed out: " + JSON.stringify(await read()));
}

test("native PowerShell preserves interactive editing, history predictions, sessions and application input", { skip: process.platform !== "win32" || process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 180000 }, async () => {
  // Windows CI can expose TEMP through an 8.3 alias, while PowerShell reports
  // the expanded path from Get-Location. Compare the same canonical directory.
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(tempRoot, "piora-native-terminal-"));
  const originalShell = process.env.PI_TERMINAL_SHELL;
  // Legacy configuration must never choose cmd.exe for the new terminal.
  process.env.PI_TERMINAL_SHELL = "cmd.exe";
  const history = path.join(root, "history", "ConsoleHost_history.txt");
  await mkdir(path.dirname(history), { recursive: true });
  await mkdir(path.join(root, "child"));
  const acceptedFile = path.join(root, "accepted.txt");
  const historyCommand = "Set-Content -Path accepted.txt -Value 'HISTORY_EXECUTED'";
  await writeFile(history, historyCommand + "\n");
  const store = new ShellStore(root, false);
  globalThis.__pioraShellStore = store;
  allowFileRoot(root);
  let browser;
  const originalSpawn = pty.spawn;
  // Emulate a user profile before the production startup command. Windows uses
  // Known Folders for history, so changing APPDATA alone cannot isolate it.
  pty.spawn = (executable, args, options) => {
    if (args.includes("-Command")) {
      args = [...args];
      args[args.length - 1] = `Import-Module PSReadLine; Set-PSReadLineOption -HistorySavePath '${history.replaceAll("'", "''")}' -HistorySaveStyle SaveIncrementally; function global:prompt { 'PS TEST> ' }; ` + args.at(-1);
    }
    return originalSpawn(executable, args, options);
  };
  const subscriptions = new Map();
  let forwarding = Promise.resolve();
  try {
    const profile = await resolveNativeShellProfile();
    assert.equal(profile.label, "PowerShell 7");
    assert.equal(profile.native, true);
    assert.equal(profile.integrated, false);
    const launch = await prepareShellLaunch(profile, randomUUID(), "unused", root);
    assert.ok(!launch.args.includes("-NoProfile"));
    assert.equal(launch.env.PIORA_SHELL_TOKEN, undefined);
    const legacy = await createShell(root, "cmd.exe");
    const [session, duplicate] = await Promise.all([ensureDefaultShell(root, true), ensureDefaultShell(root, true)]);
    assert.equal(session.state.id, duplicate.state.id);
    assert.notEqual(session.state.id, legacy.state.id);
    assert.deepEqual((await listShells(root, true)).map(s => s.id), [session.state.id]);
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react"; import {createRoot} from "react-dom/client";',
      `import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};`,
      `import {CommandPanel} from ${JSON.stringify(path.join(repo, "components/workspace/CommandPanel.tsx"))};`,
      `createRoot(document.getElementById("root")).render(<I18nProvider><CommandPanel cwd={${JSON.stringify(root)}} /></I18nProvider>);`,
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "https://native-terminal.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
    page.setDefaultTimeout(15000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("terminalSnapshot", async id => {
      const shell = await getShell(id), snapshot = shell.snapshot();
      return { type: "snapshot", terminalId: id, generation: shell.state.generation, sequence: snapshot.sequence, snapshot };
    });
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      window.streams = new Set();
      window.EventSource = class {
        constructor(url) {
          this.id = url.split("/").at(-2); window.streams.add(this);
          window.terminalSnapshot(this.id).then(snapshot => this.onmessage?.({ data: JSON.stringify(snapshot) }));
        }
        close() { window.streams.delete(this); }
      };
      window.emitTerminal = event => { for (const stream of window.streams) if (event.terminalId === stream.id) stream.onmessage?.({ data: JSON.stringify(event) }); };
      window.piDesktop = { clipboard: { readText: async () => "Write-Output '中文粘贴'", writeText: async () => {} } };
    });
    const [xtermCss, terminalCss, panelCss] = await Promise.all(["node_modules/@xterm/xterm/css/xterm.css", "components/workspace/TerminalPanel.module.css", "components/workspace/SmartShell.module.css"].map(file => readFile(path.join(repo, file), "utf8")));
    // Only TerminalSurface uses this older stylesheet; other selectors have
    // distinct module names in the application and must not collide here.
    const css = [xtermCss, terminalCss.split("\n").filter(line => line.startsWith(".surface")).join("\n"), panelCss].join("\n").replace(/:global\(([^)]+)\)/g, "$1");
    const subscribe = async () => {
      for (const state of await listShells(root, true)) {
        if (subscriptions.has(state.id)) continue;
        const shell = await getShell(state.id);
        subscriptions.set(state.id, shell.subscribe(event => { forwarding = forwarding.then(() => page.evaluate(event => window.emitTerminal?.(event), event)).catch(() => {}); }));
      }
    };
    await subscribe();
    await page.route("https://native-terminal.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith("/api/shell/")) {
        const body = request.postData();
        requests.push({ url: url.pathname, body: body ? JSON.parse(body) : null });
        const response = await handleShellRequest(new Request("http://localhost" + url.pathname + url.search, { method: request.method(), headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" }, ...(body ? { body } : {}) }), url.pathname.slice("/api/shell/".length).split("/"));
        await subscribe();
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><style>:root{--ui-font-size:14px;--text:#dce3ec;--text-muted:#9aa8b8;--bg-panel:#171b21;--border:#333;--accent:#80d4c4}*{box-sizing:border-box}body{margin:0;font:14px system-ui}#root{height:100vh;width:100vw}' + css + '</style><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://native-terminal.test/");
    const input = page.locator(".xterm-helper-textarea");
    const screen = () => page.locator(".xterm-rows").innerText();
    await until(screen, text => /PS .*>/.test(text));
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    const shellPicker = page.getByRole("combobox", { name: "选择 Shell 新建" });
    await until(() => shellPicker.isEnabled(), Boolean);
    assert.equal(await page.getByRole("tab").count(), 1, "legacy tabs do not appear in the native panel");

    const diagnostics = path.join(root, "readline.json");
    session.input(`Get-PSReadLineOption | Select-Object PredictionSource,PredictionViewStyle,HistorySavePath | ConvertTo-Json | Set-Content -LiteralPath '${diagnostics.replaceAll("'", "''")}'\r`);
    const readline = await until(() => readFile(diagnostics, "utf8").then(JSON.parse).catch(() => null), Boolean);
    assert.equal(readline.HistorySavePath, history, JSON.stringify(readline));
    assert.equal(readline.PredictionSource, 2);
    assert.equal(readline.PredictionViewStyle, 0);
    const waitForPrompt = () => until(screen, text => text.trimEnd().endsWith("PS TEST>"));
    await waitForPrompt();

    // A real PSReadLine prediction must be rendered, filled, then executed only on Enter.
    await page.keyboard.type("Set-Content -Path ");
    await until(screen, text => text.includes("HISTORY_EXECUTED"));
    await page.keyboard.press("ArrowRight");
    assert.equal(await access(acceptedFile).then(() => true, () => false), false);
    await page.keyboard.press("Enter");
    await until(() => readFile(acceptedFile, "utf8").catch(() => ""), text => text.trim() === "HISTORY_EXECUTED");

    const run = async command => {
      const marker = randomUUID().replaceAll("-", "");
      // Output/file writes can finish before PSReadLine is ready for new input,
      // especially after Ctrl+C interrupts a foreground command.
      await waitForPrompt();
      await input.focus();
      await page.keyboard.insertText(command + `; Write-Output ('DONE_' + '${marker}')`);
      await page.keyboard.press("Enter");
      await until(screen, text => text.includes("DONE_" + marker) && text.trimEnd().endsWith("PS TEST>"));
    };
    await run("$NativeValue = 41; Set-Location child");
    await run("Write-Output ('STATE=' + ($NativeValue + 1) + ':' + (Get-Location).Path)");
    const stateScreen = await screen();
    assert.ok(stateScreen.replaceAll("\n", "").includes("STATE=42:" + path.join(root, "child")), stateScreen);
    await run("Get-PSReadLineOption | Select-Object PredictionSource,PredictionViewStyle");
    assert.match(await screen(), /History\s+InlineView/);
    await page.keyboard.press("Control+v");
    await until(screen, text => text.includes("中文粘贴"));
    await page.keyboard.press("Enter");
    await run("Write-Output 'AFTER_PASTE'");
    await page.keyboard.press("Control+r");
    await page.keyboard.type("AFTER_PASTE");
    await until(screen, text => text.includes("bck-i-search"));
    await page.keyboard.press("Control+c");
    await run("Write-Output 'AFTER_SEARCH'");
    await page.reload();
    await until(screen, text => text.includes("AFTER_SEARCH"));
    await run("Write-Output ('RESTORED=' + $NativeValue)");
    assert.ok((await screen()).includes("RESTORED=41"));
    await run("Set-Location ..");
    await run("Write-Output 'PROMPT_READY'");
    await page.keyboard.insertText("Write-Output ('SLEEP' + '_STARTED'); Start-Sleep 30");
    await page.keyboard.press("Enter");
    await until(screen, text => text.includes("SLEEP_STARTED"));
    await page.keyboard.press("Control+c");
    await run("Write-Output 'INTERRUPTED_OK'");

    const tui = path.join(root, "tui.cjs");
    await writeFile(tui, 'process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[HNATIVE_TUI");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",data=>{if(data.includes(113)){process.stdin.setRawMode(false);process.stdout.write("\\x1b[?1049l");process.exit(0)}})');
    await page.keyboard.insertText(`node '${tui.replaceAll("'", "''")}'`);
    await page.keyboard.press("Enter");
    await until(screen, text => text.includes("NATIVE_TUI"));
    await page.keyboard.press("q");
    await run("Write-Output 'TUI_CLOSED'");
    await page.getByRole("button", { name: "清空终端显示", exact: true }).click();
    await until(screen, text => !text.includes("TUI_CLOSED") && text.includes("PS "));

    await page.getByRole("button", { name: "新建终端", exact: true }).click();
    await until(() => page.getByRole("tab").count(), count => count === 2);
    await until(screen, text => /PS .*>/.test(text));
    await run("Write-Output ('ISOLATED=' + ($null -eq $NativeValue))");
    assert.ok((await screen()).includes("ISOLATED=True"));
    await page.getByRole("button", { name: "关闭终端 2", exact: true }).click();
    await until(() => page.getByRole("tab").count(), count => count === 1);
    await run("Write-Output ('ORIGINAL=' + $NativeValue)");
    assert.ok((await screen()).includes("ORIGINAL=41"));
    const cmd = await shellPicker.locator("option").evaluateAll(options => options.find(option => option.textContent === "Command Prompt")?.value);
    assert.ok(cmd, "Command Prompt is discovered alongside PowerShell");
    await shellPicker.selectOption(cmd);
    await until(() => page.getByRole("tab").count(), count => count === 2);
    await until(screen, text => text.includes("Microsoft Windows"));
    await input.focus();
    await page.keyboard.insertText("echo PIORA_CMD_SELECTED");
    await page.keyboard.press("Enter");
    await until(screen, text => text.includes("PIORA_CMD_SELECTED"));
    assert.equal((await listShells(root, true)).filter(item => item.profile.kind === "cmd").length, 1);
    await page.getByRole("button", { name: "关闭终端 2", exact: true }).click();
    await until(() => page.getByRole("tab").count(), count => count === 1);
    await until(() => page.getByRole("tab", { selected: true }).innerText(), label => label.includes("PowerShell"));
    await run("Write-Output ('SHELL_SWITCH_PRESERVED=' + $NativeValue)");
    assert.ok((await screen()).includes("SHELL_SWITCH_PRESERVED=41"));
    const bash = await shellPicker.locator("option").evaluateAll(options => options.find(option => option.textContent === "Git Bash")?.value);
    if (bash) {
      await shellPicker.selectOption(bash);
      await until(() => page.getByRole("tab").count(), count => count === 2);
      await until(screen, text => text.trimEnd().endsWith("$"));
      await input.focus();
      await page.keyboard.insertText("unset HISTFILE; printf 'PIORA_BASH_%s\\n' SELECTED; pwd -W; type -P ls");
      await page.keyboard.press("Enter");
      await until(screen, text => text.includes("PIORA_BASH_SELECTED") && text.includes("/usr/bin/ls"));
      assert.ok((await screen()).toLowerCase().includes(root.replaceAll("\\", "/").toLowerCase()), "Git Bash preserves the project directory");
      await page.getByRole("button", { name: "关闭终端 2", exact: true }).click();
      await until(() => page.getByRole("tab").count(), count => count === 1);
      await until(() => page.getByRole("tab", { selected: true }).innerText(), label => label.includes("PowerShell"));
      await run("Write-Output 'BACK_FROM_BASH'");
    }
    await page.getByRole("button", { name: "重启终端", exact: true }).click();
    await until(() => session.state.generation, value => value >= 3);
    await until(screen, text => text.trimEnd().endsWith("PS TEST>"));
    await input.focus();
    await page.keyboard.type("Set-Content -Path ");
    await until(screen, text => text.includes("HISTORY_EXECUTED"));
    await page.keyboard.press("Control+c");
    for (const width of [360, 700]) {
      const before = requests.filter(item => item.body?.action === "resize").length;
      await page.setViewportSize({ width, height: 680 });
      await until(() => requests.filter(item => item.body?.action === "resize").length, count => count > before);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.getByRole("button", { name: "清空终端显示", exact: true }).click();
    await until(screen, text => text.trim() === "PS TEST>");
    await page.keyboard.type("Set-Content -Path ");
    await until(screen, text => text.includes("HISTORY_EXECUTED"));
    if (process.env.PIORA_NATIVE_TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.PIORA_NATIVE_TERMINAL_SCREENSHOT });
    assert.equal(requests.some(item => item.body?.action === "submit" || /\/timeline$|\/history|\/completions/.test(item.url)), false);
    assert.deepEqual(session.snapshot().commands, [], "native commands bypass AI classification and command wrappers");
    assert.deepEqual(errors, []);
  } finally {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    await forwarding;
    await browser?.close();
    for (const shell of globalThis.__pioraManagedShells?.values() || []) await shell.dispose();
    globalThis.__pioraManagedShells?.clear();
    await store.close(); globalThis.__pioraShellStore = undefined;
    pty.spawn = originalSpawn;
    if (originalShell === undefined) delete process.env.PI_TERMINAL_SHELL; else process.env.PI_TERMINAL_SHELL = originalShell;
    assert.ok(path.resolve(root).startsWith(tempRoot + path.sep) && path.basename(root).startsWith("piora-native-terminal-"));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
