import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
let reconcile, manual;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "reconcileAgentState") reconcile = node.getText(parsed);
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect" && node.arguments[0]?.getText(parsed).includes("if (!isCompacting || agentRunning) return;")) manual = node.getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const requests = [], updates = [], completed = [];
  const env = {
    AbortController, AbortSignal, useCallback: fn => fn,
    agentRunningRef: { current: true }, preparingPromptRunIdRef: { current: null }, promptRunIdRef: { current: 1 },
    phaseEventRevisionRef: { current: 1 }, cancelledPromptRunIdRef: { current: null },
    reconciliationRef: { current: null }, sessionIdRef: { current: "task" }, systemPromptSelectionRef: { current: null },
    normalizeQueuedMessages: value => value ?? { steering: [], followUp: [] }, selectionFromSystemPromptBinding: () => ({}),
    fetch: async (url, { signal }) => new Promise((resolve, reject) => {
      requests.push({ url, signal, reject, respond: data => resolve({ ok: true, json: async () => data }) });
    }),
    promptSubmissionRef: { current: null },
    isPromptCommandSettled: (commandId, command) => !commandId || (command?.commandId === commandId
      && ["completed", "failed", "cancelled", "expired", "interrupted"].includes(command.status)),
    finishPromptWithoutStream: async (sid, run) => { completed.push([sid, run]); },
    restoreStatusClock: value => updates.push(["clock", value]),
  };
  for (const name of ["setIsCompacting", "setCompactionStartedAt", "setQueuedMessages", "setCapabilities", "setCurrentModelOverride", "setThinkingLevel", "setAgentPhase", "setContextUsage", "setSystemPrompt", "setSystemPromptBinding", "setSystemPromptSelection", "setExtensionStatuses", "setExtensionWidgets"]) env[name] = value => updates.push([name, value]);
  runInNewContext(compile(`const ${reconcile}; globalThis.reconcile = reconcileAgentState;`), env);
  return { env, requests, updates, completed };
}

test("slow status requests do not overlap, and missing terminal events still settle", async () => {
  const f = fixture();
  const pending = f.env.reconcile("task");
  await Promise.all(Array.from({ length: 10 }, () => f.env.reconcile("task")));
  assert.equal(f.requests.length, 1);
  f.requests[0].respond({ running: false }); await pending;
  assert.deepEqual(f.completed, [["task", 1]]); assert.equal(f.env.reconciliationRef.current, null);
});

test("a newer task run bypasses a slow old request and ignores its late response", async () => {
  const f = fixture(); const old = f.env.reconcile("task");
  f.env.sessionIdRef.current = "next"; f.env.promptRunIdRef.current = 2;
  const current = f.env.reconcile("next");
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].respond({ running: false }); await old;
  assert.equal(f.updates.length, 0); assert.equal(f.completed.length, 0);
  await f.env.reconcile("next"); assert.equal(f.requests.length, 2, "old cleanup cannot clear the new request lock");
  f.requests[1].respond({ running: false }); await current;
  assert.deepEqual(f.completed, [["next", 2]]);
});

test("network failures release the request and allow immediate recovery", async () => {
  const f = fixture(); const first = f.env.reconcile("task");
  f.requests[0].reject(new Error("offline")); await first;
  const retry = f.env.reconcile("task"); assert.equal(f.requests.length, 2);
  f.requests[1].respond({ running: true, state: { runtime: "running", isPromptRunning: true } }); await retry;
  assert.equal(f.completed.length, 0);
});

test("unmounted or cancelled reconciliation cannot mutate a newer UI", async () => {
  const f = fixture(); const pending = f.env.reconcile("task");
  f.env.reconciliationRef.current.controller.abort(); f.env.reconciliationRef.current = null;
  f.requests[0].respond({ running: false }); await pending;
  assert.equal(f.updates.length, 0); assert.equal(f.completed.length, 0);
});

test("manual compaction coalesces timer and reconnect checks, retries and ignores late replies on unmount", async () => {
  const f = fixture(); const listeners = new Map(); let tick, cleanup, closed = 0, loaded = 0;
  Object.assign(f.env, {
    isCompacting: true, agentRunning: false, AGENT_STATE_RECONCILE_MS: 2500,
    manualCompactionPendingRef: { current: false }, bashRunningRef: { current: false },
    useEffect: callback => { cleanup = callback(); },
    closeEvents: () => { closed++; }, loadSession: async () => { loaded++; },
    document: { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    window: { setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {}, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
  });
  f.env.agentRunningRef.current = false;
  runInNewContext(compile(manual), f.env);
  tick(); listeners.get("online")(); listeners.get("visibilitychange")();
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error("offline")); await settle(); tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].respond({ state: { isCompacting: false } }); await settle();
  assert.equal(closed, 1); assert.equal(loaded, 1);
  tick(); assert.equal(f.requests.length, 3);
  cleanup(); assert.equal(f.requests[2].signal.aborted, true); assert.equal(listeners.size, 0);
  f.requests[2].respond({ state: { isCompacting: false } }); await settle();
  assert.equal(closed, 1); assert.equal(loaded, 1);
});
