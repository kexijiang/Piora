import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve the transport used by Hypium rather than an unrelated test dependency.
const hypiumRequire = createRequire(new URL("../node_modules/hypium-driver/package.json", import.meta.url));
const grpc = hypiumRequire("@grpc/grpc-js");
const serialize = value => Buffer.from(JSON.stringify(value));
const deserialize = bytes => JSON.parse(bytes.toString());
const unary = path => ({ path, requestStream: false, responseStream: false, requestSerialize: serialize, requestDeserialize: deserialize, responseSerialize: serialize, responseDeserialize: deserialize });

test("Hypium gRPC security patch preserves unary metadata and in-flight cancellation", { timeout: 10_000 }, async t => {
  assert.equal(hypiumRequire("@grpc/grpc-js/package.json").version, "1.14.6");
  const server = new grpc.Server();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let markCancelled;
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  server.addService({ echo: unary("/piora.Compatibility/Echo"), slow: unary("/piora.Compatibility/Slow") }, {
    echo: (call, callback) => callback(null, { request: call.request, token: call.metadata.get("x-piora-test")[0] }),
    slow: call => { call.once("cancelled", markCancelled); markStarted(); },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  t.after(() => { client.close(); server.forceShutdown(); });
  const metadata = new grpc.Metadata();
  metadata.set("x-piora-test", "reviewed-transport");
  const result = await new Promise((resolve, reject) => client.makeUnaryRequest("/piora.Compatibility/Echo", serialize, deserialize, { action: "observe" }, metadata, { deadline: Date.now() + 5_000 }, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(result, { request: { action: "observe" }, token: "reviewed-transport" });
  let request;
  const pending = new Promise(resolve => { request = client.makeUnaryRequest("/piora.Compatibility/Slow", serialize, deserialize, {}, metadata, { deadline: Date.now() + 5_000 }, error => resolve(error)); });
  await started;
  request.cancel();
  assert.equal((await pending).code, grpc.status.CANCELLED);
  await cancelled;
});

for (const phase of ["request", "response"]) {
  test(`Hypium gRPC does not disclose internal ${phase} codec errors to clients`, { timeout: 10_000 }, async t => {
    const secret = "private-server-path-and-credential";
    const method = unary(`/piora.Compatibility/Reject${phase}`);
    if (phase === "request") method.requestDeserialize = () => { throw new Error(secret); };
    else method.responseSerialize = () => { throw new Error(secret); };
    const server = new grpc.Server();
    server.addService({ reject: method }, { reject: (_call, callback) => callback(null, {}) });
    const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
    const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    t.after(() => { client.close(); server.forceShutdown(); });
    const error = await new Promise(resolve => client.makeUnaryRequest(method.path, serialize, deserialize, {}, { deadline: Date.now() + 5_000 }, resolve));
    assert.equal(error.code, grpc.status.INTERNAL);
    assert.equal(error.details, phase === "request" ? "Error deserializing request" : "Error serializing response");
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error.metadata.getMap()), new RegExp(secret));
  });
}
