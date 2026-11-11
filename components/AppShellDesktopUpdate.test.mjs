import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Run the actual AppShell callbacks with an IPC fixture, as the session-selection
// suites do. No installer is launched and no application is stopped by this test.
const source = ts.createSourceFile("AppShell.tsx", readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
    const callback = node.initializer.arguments[0];
    if (callback && ts.isArrowFunction(callback)) callbacks.set(node.name.text, callback.getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);

function harness(installUpdate) {
  let state = { status: "downloaded", currentVersion: "0.5.10", availableVersion: "0.5.11-beta.1", releaseNotes: "Current release notes" };
  let open = true;
  const visibility = [], pending = { current: false };
  const context = vm.createContext({
    Error,
    window: { piDesktop: installUpdate ? { installUpdate } : undefined },
    desktopUpdateInstallPendingRef: pending,
    desktopUpdateState: state,
    setDesktopUpdateDialogOpen(value) { open = value; visibility.push(value); },
    setDesktopUpdateState(value) { state = typeof value === "function" ? value(state) : value; },
  });
  const load = name => {
    assert.ok(callbacks.has(name), `Use the actual ${name} callback`);
    return vm.runInContext(ts.transpileModule(`(${callbacks.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  };
  return { install: load("handleInstallDesktopUpdate"), show: load("handleOpenDesktopUpdate"), visibility, pending, state: () => state, open: () => open };
}

test("install closes the update dialog before IPC, blocks duplicate clicks and ignores reopen requests until completion", async () => {
  let finish, calls = 0;
  const h = harness(() => { calls++; assert.equal(h.open(), false, "the dialog closes before freshness checking starts"); return new Promise(resolve => { finish = resolve; }); });
  const installing = h.install();
  assert.equal(h.pending.current, true);
  await h.install();
  h.show();
  assert.equal(calls, 1);
  assert.deepEqual(h.visibility, [false], "update notifications or menu events cannot reopen the dialog during installation");
  finish(true);
  await installing;
  assert.equal(h.open(), false);
  assert.equal(h.pending.current, false);
});

test("a blocked or deferred installation restores the downloaded update dialog and permits retry", async () => {
  let calls = 0;
  const h = harness(async () => ++calls > 1);
  await h.install();
  assert.equal(h.open(), true);
  assert.equal(h.state().status, "downloaded");
  assert.equal(h.state().releaseNotes, "Current release notes");
  await h.install();
  assert.equal(calls, 2);
  assert.equal(h.open(), false);
  assert.equal(h.pending.current, false);
});

test("an IPC failure reopens the update dialog with the actual error and retains the target notes", async () => {
  const h = harness(async () => { throw new Error("Installer handoff failed"); });
  await h.install();
  assert.equal(h.open(), true);
  assert.equal(h.state().status, "error");
  assert.equal(h.state().error, "Installer handoff failed");
  assert.equal(h.state().releaseNotes, "Current release notes");
  assert.equal(h.pending.current, false);
});

test("an unavailable desktop bridge leaves the update dialog alone", async () => {
  const h = harness();
  await h.install();
  assert.equal(h.open(), true);
  assert.equal(h.pending.current, false);
  assert.deepEqual(h.visibility, []);
});
