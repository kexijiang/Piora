import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const cwdHandler = source.slice(
  source.indexOf("const handleCwdChange"),
  source.indexOf("const handleSelectSession"),
);

const syntax = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let selectionCallback;
let nativeUrlReplacement;
let selectionHistoryState;
function findSelectionHandlers(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "handleSelectSession") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    selectionCallback = node.initializer.arguments[0];
    assert.ok(ts.isArrowFunction(selectionCallback));
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "replaceUrlWithoutNextNavigation") {
    nativeUrlReplacement = node;
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "getSelectionHistoryState") {
    selectionHistoryState = node;
  }
  ts.forEachChild(node, findSelectionHandlers);
}
findSelectionHandlers(syntax);
assert.ok(selectionCallback && nativeUrlReplacement && selectionHistoryState, "run the actual AppShell selection callback and URL helpers");

function createSelectionHarness(selectedId, {
  isMobile = false,
  href = "https://piora.test/",
  initialHistoryState = { __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "retained" }, ownedCustomData: "retained" },
} = {}) {
  const calls = new Map();
  const frameCallbacks = [];
  const historyWrites = [];
  const location = { href };
  const history = {
    state: initialHistoryState,
    replaceState(state, title, url) {
      historyWrites.push({ state, title, url });
      history.state = state;
      location.href = new URL(url, location.href).href;
    },
  };
  const context = {
    isMobile,
    selectedSessionIdRef: { current: selectedId },
    suppressCwdBumpRef: { current: false },
    chatInputRef: { current: { focus: () => calls.set("focus", (calls.get("focus") ?? 0) + 1) } },
    window: { history, location, requestAnimationFrame: (callback) => frameCallbacks.push(callback) },
  };
  for (const name of [
    "setSettingsDialogOpen", "setHistoryDialogOpen", "setHistoryLocation", "setSelectedRoom",
    "setActiveTopPanel", "setNewSessionCwd", "setNewSessionInitialModel", "setNewSessionInitialPrompt",
    "setSelectedSession", "setFocusedEntryId", "setSessionKey", "setSystemPrompt",
    "setInitialSessionRestored", "setSidebarOpen",
  ]) {
    context[name] = (value) => calls.set(name, [...(calls.get(name) ?? []), value]);
  }
  const sandbox = vm.createContext(context);
  const transpile = (text) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(transpile(`${selectionHistoryState.getText(syntax)}\n${nativeUrlReplacement.getText(syntax)}`), sandbox);
  const select = vm.runInContext(transpile(`(${selectionCallback.getText(syntax)})`), sandbox);
  return {
    select, calls, historyWrites, location, context, initialHistoryState,
    flushFrames() { while (frameCallbacks.length) frameCallbacks.shift()(); },
    pendingFrames: () => frameCallbacks.length,
  };
}

test("selecting a session in another project survives cwd synchronization", () => {
  assert.match(cwdHandler, /const cwdBelongsToSelectedSession = selectedSession\?\.cwd === cwd/);
  assert.match(cwdHandler, /const cwdBelongsToSelectedRoom = Boolean/);
  assert.match(
    cwdHandler,
    /if \(!cwdBelongsToCurrentSelection\) \{[\s\S]*?setSelectedSession\(null\);[\s\S]*?setSelectedRoom\(null\);[\s\S]*?setSessionKey/,
  );
  assert.match(
    cwdHandler,
    /if \(!cwdBelongsToCurrentSelection\) \{\s*replaceUrlWithoutNextNavigation\("\/"\);\s*\}/,
  );
});

test("selection URL updates permit native Next synchronization with an empty history state", () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  for (const initialHistoryState of [null, {}]) {
    const harness = createSelectionHarness(session.id, { initialHistoryState });
    harness.select(session);
    assert.equal(new URL(harness.location.href).searchParams.get("session"), session.id);
    assert.equal(harness.historyWrites.length, 1);
    assert.deepEqual(Object.keys(harness.historyWrites[0].state), []);
    assert.equal(harness.calls.has("setSessionKey"), false);
  }
});

test("session selection restores focus to the remounted composer", () => {
  const selectionHandler = source.slice(
    source.indexOf("const handleSelectSession"),
    source.indexOf("const handleNewSession"),
  );
  assert.match(selectionHandler, /requestAnimationFrame[^]*chatInputRef\.current\?\.focus\(\)/);
});

test("clicking the selected session restores its URL without remounting the chat", () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  const harness = createSelectionHarness(session.id);
  harness.select(session);

  assert.equal(new URL(harness.location.href).searchParams.get("session"), session.id);
  assert.equal(harness.historyWrites.length, 1);
  assert.equal(Object.hasOwn(harness.historyWrites[0].state, "__NA"), false);
  assert.equal(Object.hasOwn(harness.historyWrites[0].state, "_N"), false);
  assert.equal(harness.historyWrites[0].state.ownedCustomData, "retained");
  assert.equal(harness.historyWrites[0].state.__PRIVATE_NEXTJS_INTERNALS_TREE,
    harness.initialHistoryState.__PRIVATE_NEXTJS_INTERNALS_TREE);
  assert.equal(harness.initialHistoryState.__NA, true, "the stored state is not mutated before Next copies its data");
  assert.equal(harness.initialHistoryState._N, true);
  assert.deepEqual(harness.calls.get("setActiveTopPanel"), [null]);
  for (const setter of ["setSessionKey", "setSelectedSession", "setNewSessionCwd", "setFocusedEntryId"]) {
    assert.equal(harness.calls.has(setter), false, `${setter} must not disturb the current chat`);
  }
  assert.equal(harness.pendingFrames(), 0);
});

test("clicking another session keeps the normal selection and remount path", () => {
  const session = { id: "owned-session-2", cwd: "F:\\Piora" };
  const harness = createSelectionHarness("owned-session-1", { isMobile: true });
  harness.select(session);

  assert.equal(new URL(harness.location.href).searchParams.get("session"), session.id);
  assert.deepEqual(harness.calls.get("setSelectedSession"), [session]);
  assert.equal(harness.calls.get("setSessionKey").length, 1);
  assert.equal(harness.calls.get("setSessionKey")[0](4), 5);
  assert.deepEqual(harness.calls.get("setSidebarOpen"), [false]);
  assert.equal(harness.context.suppressCwdBumpRef.current, false);
  harness.flushFrames();
  assert.equal(harness.calls.get("focus"), 1);
});

test("restoring a session from history never rewrites the URL", () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  const href = `https://piora.test/?session=${session.id}&entry=owned-entry`;
  for (const selectedId of [session.id, "owned-session-2"]) {
    const harness = createSelectionHarness(selectedId, { href, isMobile: true });
    harness.select(session, true);

    assert.equal(harness.location.href, href);
    assert.equal(harness.historyWrites.length, 0);
    assert.deepEqual(harness.calls.get("setSelectedSession"), [session]);
    assert.equal(harness.calls.get("setSessionKey").length, 1);
    assert.equal(harness.context.suppressCwdBumpRef.current, true);
    assert.equal(harness.calls.has("setHistoryLocation"), false);
    assert.equal(harness.calls.has("setFocusedEntryId"), false);
    assert.equal(harness.calls.has("setSidebarOpen"), false);
    assert.equal(harness.pendingFrames(), 0);
  }
});
