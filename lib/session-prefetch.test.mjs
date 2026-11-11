import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./session-prefetch.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(respond) {
  const requests = [];
  const context = { exports: {}, Blob, AbortController, AbortSignal, window: { setTimeout() {} },
    fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options); } };
  vm.runInNewContext(compiled, context);
  return { ...context.exports, requests };
}

test("prepares history and runtime together and exposes the exact fresh snapshot for the first render", async () => {
  let releaseHistory, releaseState;
  const history = new Promise(resolve => { releaseHistory = resolve; });
  const state = new Promise(resolve => { releaseState = resolve; });
  const h = harness(url => url.endsWith("/state") ? state : history);
  const session = { id: "cold", modified: "sidebar-version" };
  let ready = false;
  const preparing = h.prepareSessionSwitch(session).then(result => { ready = true; return result; });
  assert.equal(h.requests.length, 2, "runtime and history start without a serial network roundtrip");
  releaseHistory(Response.json({ context: { messages: [{ role: "user", content: "latest" }] }, info: { modified: "fresh-version" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false, "running state must be ready before the target chat commits");
  releaseState(Response.json({ running: true, state: { runtime: "running", isPromptRunning: true } }));
  const snapshot = await preparing;
  assert.equal(snapshot.initialAgentState.state.isPromptRunning, true);
  assert.equal(h.peekPrefetchedSession({ ...session, modified: "fresh-version" }), snapshot);
  assert.equal(h.peekPrefetchedSession(session), null, "an older sidebar stamp cannot reuse a newer snapshot as if it were unchanged");
});

test("refreshes a cached idle history when the background session has since started running", async () => {
  let running = false, historyRequests = 0;
  const session = { id: "background", modified: "same-version" };
  const h = harness(url => Response.json(url.endsWith("/state") ? { running, state: { runtime: running ? "running" : "idle" } }
    : { info: { modified: session.modified }, context: { messages: [{ role: "user", content: ++historyRequests === 1 ? "old" : "active" }] } }));
  await h.takePrefetchedSession(session);
  const idle = await h.prepareSessionSwitch(session);
  assert.equal(historyRequests, 1, "an unchanged idle hover snapshot remains reusable");
  assert.equal(idle.initialAgentState.running, false);
  running = true;
  const active = await h.prepareSessionSwitch(session);
  assert.equal(historyRequests, 2);
  assert.equal(active.context.messages[0].content, "active");
  assert.equal(active.initialAgentState.running, true);
  assert.equal(h.peekPrefetchedSession(session), active);
});

test("a failed history never becomes a usable switch snapshot", async () => {
  const h = harness(url => url.endsWith("/state") ? Response.json({ running: false }) : new Response("offline", { status: 503 }));
  const session = { id: "offline", modified: "one" };
  assert.equal(await h.prepareSessionSwitch(session), null);
  assert.equal(h.peekPrefetchedSession(session), null);
});
