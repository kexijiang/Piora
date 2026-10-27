import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { desktopDevelopmentEnvironment } from "../scripts/desktop-dev-environment.mjs";

const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
function method(name, end, bindings) {
  const source = main.slice(main.indexOf(`function ${name}(`), main.indexOf(end, main.indexOf(`function ${name}(`)));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { ...bindings };
  runInNewContext(compiled + `;globalThis.subject = ${name};`, context);
  return context;
}

test("dev launcher isolates both processes from published agent/runtime data unless explicitly overridden", () => {
  const root = resolve("project");
  const value = desktopDevelopmentEnvironment(root, {});
  assert.equal(value.PIORA_DESKTOP_DEV_USER_DATA, join(root, ".piora-data", "desktop-dev"));
  assert.equal(value.PI_CODING_AGENT_DIR, join(value.PIORA_DESKTOP_DEV_USER_DATA, "agent"));
  assert.equal(value.PIORA_DESKTOP_DATA_DIR, join(value.PIORA_DESKTOP_DEV_USER_DATA, "runtime", "normal"));
  const other = desktopDevelopmentEnvironment(resolve("other-project"), {});
  assert.notEqual(other.PIORA_DESKTOP_DEV_USER_DATA, value.PIORA_DESKTOP_DEV_USER_DATA);
  const explicit = desktopDevelopmentEnvironment(root, { PIORA_DESKTOP_DEV_USER_DATA: "custom-dev", PI_CODING_AGENT_DIR: " explicit-agent " });
  assert.equal(explicit.PIORA_DESKTOP_DEV_USER_DATA, join(root, "custom-dev"));
  assert.equal(explicit.PI_CODING_AGENT_DIR, join(root, "explicit-agent"));
  const launcher = readFileSync(new URL("../scripts/dev-desktop.mjs", import.meta.url), "utf8");
  assert.match(launcher, /const sharedEnvironment = \{\s*\.\.\.process.env,\s*\.\.\.developmentEnvironment/);
  assert.match(launcher, /env: sharedEnvironment/);
  assert.match(launcher, /env: \{\s*\.\.\.sharedEnvironment/);
});

test("dev fallback agent directory and single-instance profile do not use the published profile", () => {
  for (const development of [true, false]) {
    const ctx = method("defaultPiAgentDirectory", "function resolvePiAgentDirectory", {
      resolve, desktopDevelopmentRuntime: development ? {} : null,
      app: { getPath: name => resolve(name === "home" ? "home" : "dev-profile") },
    });
    assert.equal(ctx.subject(), development ? resolve("dev-profile/agent") : resolve("home/.pi/agent"));
  }
  assert.ok(main.indexOf('app.setPath("userData", requestedDevUserData') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.match(main, /const DESKTOP_DISPLAY_NAME = desktopDevelopmentRuntime \? `\$\{APP_DISPLAY_NAME\} Dev` : APP_DISPLAY_NAME/);
  assert.match(main, /page-title-updated[\s\S]*?preventDefault\(\); window.setTitle\(DESKTOP_DISPLAY_NAME\)/);
});

test("dev never registers or unregisters the installed app's global new-chat binding", () => {
  for (const development of [true, false]) {
    let handler;
    const calls = [];
    const ctx = method("registerGlobalShortcutHandler", "function registerRuntimeLogHandler", {
      GLOBAL_SHORTCUT_CHANNEL: "test", desktopDevelopmentRuntime: development ? {} : null,
      ipcMain: { removeHandler() {}, handle(_channel, fn) { handler = fn; } },
      isTrustedMainWindowSender: event => event.trusted,
      focusMainWindow: intent => calls.push(intent),
      globalShortcut: { unregister: accelerator => calls.push(["unregister", accelerator]), register: (accelerator, fn) => { calls.push(["register", accelerator]); fn(); return true; } },
    });
    ctx.subject();
    assert.equal(handler({ trusted: false }, true), false);
    assert.equal(handler({ trusted: true }, true), !development);
    assert.equal(handler({ trusted: true }, false), true);
    if (development) assert.deepEqual(calls, []);
    else { assert.ok(calls.some(call => call[0] === "register")); assert.ok(calls.includes("new-session")); }
  }
});

test("dev keeps companion bindings local and cannot take a published global binding", () => {
  for (const development of [true, false]) {
    const calls = [];
    const ctx = method("syncCompanionPanelShortcut", "function showCompanionWindow", {
      desktopDevelopmentRuntime: development ? {} : null,
      keyboardShortcutBindings: { "companion.togglePanel": "Ctrl+Space" },
      companionPanelShortcutAccelerator: undefined, toElectronAccelerator: value => value,
      toggleCompanionPanel() {}, logger: { warn() {} },
      globalShortcut: { unregister: value => calls.push(["unregister", value]), register: value => { calls.push(["register", value]); return true; } },
    });
    assert.equal(ctx.subject(), true);
    assert.equal(calls.length, development ? 0 : 1);
  }
  assert.equal((main.match(/setShortcut\(desktopDevelopmentRuntime \? undefined : toElectronAccelerator/g) ?? []).length, 3,
    "startup, settings change and rollback all keep dev clipboard shortcuts local");
});
