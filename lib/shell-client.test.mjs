import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { shellRequest } = await createJiti(import.meta.url).import("./shell/client.ts");

test("connection timeout aborts a stalled request and its response body", async t => {
  for (const stage of ["headers", "body"]) {
    let signal;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      const stalled = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return stage === "headers" ? stalled() : { ok: true, json: stalled };
    });
    await assert.rejects(shellRequest("sessions", undefined, { timeoutMs: 10 }), /终端连接超时/);
    assert.equal(signal.aborted, true);
    t.mock.restoreAll();
  }
});

test("scope cancellation reaches fetch without changing the parent's signal", async t => {
  const parent = new AbortController();
  let child;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    child = options.signal;
    return new Promise((_resolve, reject) => child.addEventListener("abort", () => reject(child.reason), { once: true }));
  });
  const request = shellRequest("sessions", undefined, { signal: parent.signal, timeoutMs: 1000 });
  parent.abort(new Error("Workspace changed"));
  await assert.rejects(request, /Workspace changed/);
  assert.equal(child.aborted, true);
});

test("a durable command receipt is returned once without automatic resubmission", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ durable: true, accepted: true }));
  assert.deepEqual(await shellRequest("sessions/id/actions", { action: "submit" }), { durable: true, accepted: true });
});

test("ordinary terminal requests time out by default without retrying mutations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const result = assert.rejects(shellRequest("sessions/id", undefined, { method: "DELETE" }), /终端连接超时/);
  t.mock.timers.tick(15_000);
  await result;
  assert.equal(calls, 1);
});
