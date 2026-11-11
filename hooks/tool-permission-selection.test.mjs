import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const callback = source.slice(source.indexOf("  const handleToolPermission ="), source.indexOf("  const handleCapabilitySelection"));
const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function harness(sid = null) {
  const calls = [], notices = [];
  const env = {
    useCallback: callback => callback, isNew: !sid,
    sessionIdRef: { current: sid }, permissionSavingRef: { current: false }, permissionReadGeneration: { current: 0 },
    permissionOverrideRef: { current: undefined }, setPermissionSaving() {},
    setToolPermission(value) { env.state = value; }, acceptToolPermission(value) { env.state = value; },
    addNotice(value) { notices.push(value); }, notifyDefaultToolPermissionChanged() { calls.push("notify"); },
    saveDefaultToolPermission: async mode => { calls.push(["default", mode]); return { mode, revision: 0 }; },
    sendAgentCommand: async (id, command) => { calls.push([id, command]); return { mode: command.mode, revision: 2 }; },
  };
  return { env, calls, notices, select: new Function("env", `with(env) { ${js}; return handleToolPermission; }`)(env) };
}

test("new chat selection is saved before becoming effective, duplicate clicks and failed saves do not overwrite it", async () => {
  const { env, select, notices } = harness();
  let finish;
  env.saveDefaultToolPermission = () => new Promise(resolve => { finish = resolve; });
  const saving = select("full");
  assert.equal(env.permissionSavingRef.current, true);
  assert.equal(env.permissionOverrideRef.current, undefined);
  await select("ask");
  finish({ mode: "full", revision: 0 });
  await saving;
  assert.equal(env.state.mode, "full");
  assert.equal(env.permissionOverrideRef.current, "full");
  env.saveDefaultToolPermission = async () => { throw new Error("disk full"); };
  await select("auto");
  assert.equal(env.state.mode, "full");
  assert.equal(env.permissionOverrideRef.current, "full");
  assert.equal(env.permissionSavingRef.current, false);
  assert.match(notices[0].message, /disk full/);
});

test("existing chat selection explicitly remembers its default and cannot overwrite a different active chat", async () => {
  const { env, calls, select } = harness("chat-a");
  await select("full");
  assert.deepEqual(calls[0], ["chat-a", { type: "set_tool_permission", mode: "full", rememberDefault: true }]);
  assert.equal(calls[1], "notify");
  assert.equal(env.state.mode, "full");
  env.sendAgentCommand = async () => { env.sessionIdRef.current = "chat-b"; return { mode: "ask", revision: 3 }; };
  await select("ask");
  assert.equal(env.state.mode, "full");
});

test("a default read started before saving cannot undo the saved choice", async () => {
  const hookSource = await readFile(new URL("./useDefaultToolPermission.ts", import.meta.url), "utf8");
  const hookJs = ts.transpileModule(hookSource.slice(hookSource.indexOf("export function useDefaultToolPermission()")).replace("export function", "function"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const states = [], pendingReads = [];
  let cleanup;
  const env = {
    window: new EventTarget(), AbortController, DEFAULT_TOOL_PERMISSION_CHANGED: "default-changed",
    isPermissionMode: mode => ["ask", "auto", "review", "full"].includes(mode),
    useCallback: fn => fn, useRef: current => ({ current }),
    useState: initial => { const i = states.push(initial) - 1; return [initial, value => { states[i] = value; }]; },
    useEffect: fn => { cleanup = fn(); },
    fetch: () => new Promise(resolve => pendingReads.push(resolve)),
    saveDefaultToolPermission: async mode => ({ mode, revision: 0 }),
  };
  const hook = new Function("env", `with(env) { ${hookJs}; return useDefaultToolPermission(); }`)(env);
  await hook.save("full");
  assert.equal(states[0].mode, "full");
  pendingReads.shift()({ ok: true, json: async () => ({ mode: "auto" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states[0].mode, "full");
  env.window.dispatchEvent(new Event("default-changed"));
  pendingReads.shift()({ ok: true, json: async () => ({ mode: "review" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states[0].mode, "review");
  cleanup();
});
