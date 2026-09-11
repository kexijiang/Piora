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

test("timeout is opt-in so long-running commands are not automatically resubmitted", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ durable: true, accepted: true }));
  assert.deepEqual(await shellRequest("sessions/id/actions", { action: "submit" }), { durable: true, accepted: true });
});
