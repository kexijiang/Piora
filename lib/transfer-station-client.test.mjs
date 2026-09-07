import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { readTransferResponse, requestTransferItems } = await createJiti(import.meta.url).import("./transfer-station-client.ts");
const item = { id: "1", title: "test", content: "kept", kind: "note" };

test("empty, truncated, HTML and invalid-shape replies never masquerade as an empty library", async () => {
  for (const body of ["", '{"items":', "<html>Unavailable</html>", "null", "[]", '{"items":[{}]}']) {
    await assert.rejects(readTransferResponse(new Response(body)), /中转站.*(不完整|格式异常)/);
  }
  assert.deepEqual(await readTransferResponse(Response.json({ items: [] })), []);
});
test("HTTP errors preserve a server reason or explain a blank error body", async () => {
  await assert.rejects(readTransferResponse(new Response("", { status: 502 })), /502/);
  await assert.rejects(readTransferResponse(Response.json({ error: "磁盘已满" }, { status: 400 })), /磁盘已满/);
});
test("a transient empty read retries once and recovers the original items", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? new Response("") : Response.json({ items: [item] }));
  assert.deepEqual(await requestTransferItems(), [item]); assert.equal(calls, 2);
});
test("persistent read failure stops after two attempts", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(""); });
  await assert.rejects(requestTransferItems(), /响应不完整/); assert.equal(calls, 2);
});
test("lost write response is never retried and does not report success", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(""); });
  await assert.rejects(requestTransferItems("POST", { content: "keep" }), /内容已保留.*先刷新/); assert.equal(calls, 1);
});
test("network and timeout errors have actionable text and a later write succeeds", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("timeout", "TimeoutError"); });
  await assert.rejects(requestTransferItems("POST", {}), /请求超时/);
  globalThis.fetch = async () => Response.json({ items: [item] });
  assert.deepEqual(await requestTransferItems("POST", {}), [item]);
});
