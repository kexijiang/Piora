import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function findNode(predicate, node = source) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => findNode(predicate, child));
}
function bind(callback, scope) {
  const js = ts.transpileModule(`return (${callback.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), js)(...Object.values(scope));
}
const loadCallback = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModels").initializer.arguments[0];
const recoveryCallback = findNode(node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("if (!modelError) return;")).arguments[0];

test("a repaired catalog clears the error and stale or cancelled responses cannot restore it", async () => {
  const requests = [];
  let error = "missing cacheWrite";
  let names;
  const load = bind(loadCallback, {
    modelLoadIdRef: { current: 0 }, newSessionCwd: "/project", session: null, isNew: false,
    fetchModelCatalog: () => new Promise(resolve => requests.push(resolve)),
    setModelNames: value => { names = value; }, setModelError: value => { error = value; },
    setModelThinkingLevels() {}, setModelThinkingLevelMaps() {}, setModelList() {},
  });
  const old = load();
  const fresh = load();
  requests[1]({ models: { custom: "repaired" } });
  await fresh;
  assert.equal(error, null);
  requests[0]({ models: {}, modelError: "missing cacheWrite" });
  await old;
  assert.equal(error, null);
  assert.deepEqual(names, { custom: "repaired" });
  const controller = new AbortController();
  const cancelled = load(controller.signal);
  controller.abort();
  requests[2]({ models: {}, modelError: "stale error" });
  await cancelled;
  assert.equal(error, null);
});

test("error recovery retries in the foreground, resumes on visibility and cancels on cleanup", async () => {
  const timers = new Map();
  let nextTimer = 0;
  const document = new EventTarget();
  document.visibilityState = "visible";
  const window = new EventTarget();
  const calls = [];
  let finish;
  const cleanup = bind(recoveryCallback, {
    modelError: "missing cacheWrite", document, window, AbortController,
    setTimeout: (callback, delay) => { assert.equal(delay, 5000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    loadModels: (signal, refresh) => { calls.push({ signal, refresh }); return new Promise(resolve => { finish = resolve; }); },
  })();
  const tick = () => {
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    return callback();
  };
  document.visibilityState = "hidden";
  await tick();
  assert.equal(calls.length, 0);
  document.visibilityState = "visible";
  const pending = tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].refresh, true);
  window.dispatchEvent(new Event("online"));
  assert.equal(calls.length, 1, "do not overlap retries");
  finish();
  await pending;
  assert.equal(timers.size, 1);
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls.length, 2);
  cleanup();
  assert.equal(calls[1].signal.aborted, true);
  finish();
  await Promise.resolve();
  assert.equal(timers.size, 0);
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  assert.equal(calls.length, 2);
});
