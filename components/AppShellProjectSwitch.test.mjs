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
let historyRestorationCallback;
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
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect"
    && node.arguments[0]?.getText(syntax).includes('window.addEventListener("popstate", restore)')) {
    historyRestorationCallback = node.arguments[0];
  }
  ts.forEachChild(node, findSelectionHandlers);
}
findSelectionHandlers(syntax);
assert.ok(selectionCallback && nativeUrlReplacement && selectionHistoryState, "run the actual AppShell selection callback and URL helpers");

function createSelectionHarness(selectedId, {
  isMobile = false,
  href = "https://piora.test/",
  initialHistoryState = { __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "retained" }, ownedCustomData: "retained" },
  prepare = async session => ({ context: { messages: [] }, info: { id: session.id } }),
} = {}) {
  const calls = new Map();
  const values = new Map([["setPendingSessionSwitch", null], ["setSessionKey", 0]]);
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
    workspaceNavigationVersionRef: { current: 0 },
    chatInputRef: { current: { focus: () => calls.set("focus", (calls.get("focus") ?? 0) + 1) } },
    prepareSessionSwitch: prepare, translate: key => key,
    window: { history, location, requestAnimationFrame: (callback) => frameCallbacks.push(callback) },
  };
  for (const name of [
    "setSettingsDialogOpen", "setHistoryDialogOpen", "setHistoryLocation", "setSelectedRoom",
    "setActiveTopPanel", "setNewSessionCwd", "setNewSessionInitialModel", "setNewSessionInitialPrompt",
    "setSelectedSession", "setFocusedEntryId", "setSessionKey", "setSystemPrompt",
    "setInitialSessionRestored", "setSidebarOpen",
    "setPendingSessionSwitch", "setSessionSwitchError",
  ]) {
    context[name] = (value) => {
      calls.set(name, [...(calls.get(name) ?? []), value]);
      values.set(name, typeof value === "function" ? value(values.get(name)) : value);
      if (name === "setSelectedSession") context.selectedSessionIdRef.current = value?.id ?? null;
    };
  }
  const sandbox = vm.createContext(context);
  const transpile = (text) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(transpile(`${selectionHistoryState.getText(syntax)}\n${nativeUrlReplacement.getText(syntax)}`), sandbox);
  const select = vm.runInContext(transpile(`(${selectionCallback.getText(syntax)})`), sandbox);
  return {
    select, calls, values, historyWrites, location, context, initialHistoryState,
    run: text => vm.runInContext(transpile(text), sandbox),
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

test("selection URL updates permit native Next synchronization with an empty history state", async () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  for (const initialHistoryState of [null, {}]) {
    const harness = createSelectionHarness(session.id, { initialHistoryState });
    await harness.select(session);
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

test("clicking the selected session restores its URL without remounting the chat", async () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  const harness = createSelectionHarness(session.id);
  await harness.select(session);

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

test("clicking another session prepares the projection before the normal selection and remount path", async () => {
  const session = { id: "owned-session-2", cwd: "F:\\Piora" };
  const harness = createSelectionHarness("owned-session-1", { isMobile: true });
  await harness.select(session);

  assert.equal(new URL(harness.location.href).searchParams.get("session"), session.id);
  assert.deepEqual(harness.calls.get("setSelectedSession"), [session]);
  assert.equal(harness.calls.get("setSessionKey").length, 1);
  assert.equal(harness.calls.get("setSessionKey")[0](4), 5);
  assert.deepEqual(harness.calls.get("setSidebarOpen"), [false]);
  assert.equal(harness.context.suppressCwdBumpRef.current, false);
  harness.flushFrames();
  assert.equal(harness.calls.get("focus"), 1);
});

test("restoring a session from history never rewrites the URL", async () => {
  const session = { id: "owned-session-1", cwd: "F:\\Piora" };
  const href = `https://piora.test/?session=${session.id}&entry=owned-entry`;
  for (const selectedId of [session.id, "owned-session-2"]) {
    const harness = createSelectionHarness(selectedId, { href, isMobile: true });
    await harness.select(session, true);

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

test("a cold switch retains the current chat until its fresh version and search target are ready", async () => {
  let release;
  const h=createSelectionHarness("old",{prepare:()=>new Promise(resolve=>{release=resolve;})});
  const pending=h.select({id:"next",modified:"sidebar-old",cwd:"C:/next"},false,"target-entry");
  assert.equal(h.calls.has("setSelectedSession"),false);
  assert.equal(h.calls.has("setSessionKey"),false);
  assert.equal(h.values.get("setPendingSessionSwitch").id,"next");
  release({context:{messages:[]},info:{id:"next",modified:"server-new"}});await pending;
  assert.equal(h.calls.get("setSelectedSession")[0].modified,"server-new");
  assert.deepEqual(h.calls.get("setFocusedEntryId"),["target-entry"]);
  assert.equal(new URL(h.location.href).searchParams.get("entry"),"target-entry");
  assert.equal(h.values.get("setPendingSessionSwitch"),null);
});

test("only the latest selection commits and an older request cannot dismiss its pending state", async () => {
  const releases=new Map();
  const h=createSelectionHarness("old",{prepare:session=>new Promise(resolve=>releases.set(session.id,resolve))});
  const first=h.select({id:"first"}),last=h.select({id:"last"});
  releases.get("first")({context:{messages:[]}});await first;
  assert.equal(h.calls.has("setSelectedSession"),false);
  assert.equal(h.values.get("setPendingSessionSwitch").id,"last");
  releases.get("last")({context:{messages:[]}});await last;
  assert.deepEqual(h.calls.get("setSelectedSession").map(session=>session.id),["last"]);
});

test("failed and superseded session loads leave the current conversation selected", async () => {
  for(const failure of [null,new Error("offline")]){
    const h=createSelectionHarness("old",{prepare:async()=>{if(failure)throw failure;return null;}});
    await h.select({id:"next"});
    assert.equal(h.calls.has("setSelectedSession"),false);
    assert.equal(h.context.selectedSessionIdRef.current,"old");
    assert.equal(h.values.get("setSessionSwitchError"),"chat.sessionSwitchFailed");
    assert.equal(h.values.get("setPendingSessionSwitch"),null);
  }
  let release;
  const h=createSelectionHarness("old",{prepare:()=>new Promise(resolve=>{release=resolve;})});
  const pending=h.select({id:"next"});
  h.context.workspaceNavigationVersionRef.current++;
  release({context:{messages:[]}});await pending;
  assert.equal(h.calls.has("setSelectedSession"),false,"a newer project, room or new-chat action wins");
});

test("a search hit in the selected chat updates its anchor without remounting or reloading",async()=>{
  const h=createSelectionHarness("same",{prepare:async()=>assert.fail("must not reload the current session")});
  await h.select({id:"same"},false,"same-entry");
  assert.deepEqual(h.calls.get("setFocusedEntryId"),["same-entry"]);
  assert.equal(h.calls.has("setSessionKey"),false);
  assert.equal(new URL(h.location.href).searchParams.get("entry"),"same-entry");
});

test("returning through history to the current chat cancels an in-flight replacement", async () => {
  let release, restore;
  const h = createSelectionHarness("current", { href: "https://piora.test/?session=next", prepare: () => new Promise(resolve => { release = resolve; }) });
  Object.defineProperty(h.location, "search", { get: () => new URL(h.location.href).search });
  Object.assign(h.context, {
    AbortController, URLSearchParams, handleSelectSession: h.select,
    fetch: async () => ({ ok: true, json: async () => ({ info: { id: "next" } }) }),
    readHistoryLocation: () => ({ open: false, leafId: null, entryId: null }),
  });
  h.context.window.addEventListener = (_type, callback) => { restore = callback; };
  h.context.window.removeEventListener = () => {};
  const cleanup = h.run(`(${historyRestorationCallback.getText(syntax)})`)();
  restore();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.values.get("setPendingSessionSwitch").id, "next");
  h.location.href = "https://piora.test/?session=current";
  restore();
  assert.equal(h.values.get("setPendingSessionSwitch"), null);
  release({ context: { messages: [] }, info: { id: "next" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.selectedSessionIdRef.current, "current");
  assert.equal(h.calls.has("setSessionKey"), false);
  assert.equal(h.historyWrites.length, 0);
  cleanup();
});
