import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { createRequire } from "node:module";
import test from "node:test";
import { Client, Pool } from "undici";

test("queued Undici requests retain caller context and aborted work does not block the pool", { timeout: 15_000 }, async t => {
  const server = createServer();
  let release;
  const firstReceived = new Promise(resolve => {
    server.on("request", (req, res) => {
      if (req.url === "/held") { release = () => res.end("held"); resolve(); }
      else res.end(req.url);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pool = new Pool(origin, { connections: 1, pipelining: 1 });
  t.after(async () => { await pool.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const context = new AsyncLocalStorage();
  const observed = [];
  const requests = channel("undici:request:create");
  const observe = ({ request }) => { if (request.origin === origin) observed.push([request.path, context.getStore()]); };
  requests.subscribe(observe);
  t.after(() => requests.unsubscribe(observe));
  const send = path => context.run(path, async () => {
    const response = await pool.request({ path, method: "GET" });
    return response.body.text();
  });
  const held = send("/held");
  await firstReceived;
  const controller = new AbortController();
  const cancelled = pool.request({ path: "/cancelled", method: "GET", signal: controller.signal });
  const rejection = assert.rejects(cancelled, error => error.name === "AbortError");
  const queued = [send("/second"), send("/third")];
  controller.abort();
  release();
  await rejection;
  assert.equal(await held, "held");
  assert.deepEqual(await Promise.all(queued), ["/second", "/third"]);
  assert.deepEqual(observed.filter(([path]) => path !== "/cancelled"), [
    ["/held", "/held"], ["/second", "/second"], ["/third", "/third"],
  ]);
  assert.equal(await send("/after"), "/after");
});

test("HTTP/2 header timeout probes the live session and queued requests recover", { timeout: 15_000 }, async t => {
  // Ephemeral certificate belongs solely to this loopback TLS fixture.
  const { pki, md } = createRequire(import.meta.url)("node-forge");
  const keys = pki.rsa.generateKeyPair(2048);
  const certificate = pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  certificate.setSubject([{ name: "commonName", value: "localhost" }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(keys.privateKey, md.sha256.create());
  const server = createSecureServer({ key: pki.privateKeyToPem(keys.privateKey), cert: pki.certificateToPem(certificate) });
  const sessions = new Set();
  let sessionCount = 0;
  let pingCount = 0;
  server.on("session", session => {
    sessionCount++;
    sessions.add(session);
    session.on("ping", () => pingCount++);
    session.on("close", () => sessions.delete(session));
  });
  let held;
  const heldReceived = new Promise(resolve => { held = resolve; });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {}); // Expected RST_STREAM on the timed-out request.
    if (headers[":path"] === "/held") { held(); return; }
    stream.respond({ ":status": 200 });
    stream.end("recovered");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client(`https://127.0.0.1:${server.address().port}`, {
    allowH2: true, maxConcurrentStreams: 1, headersTimeout: 100, bodyTimeout: 1_000,
    connect: { rejectUnauthorized: false },
  });
  t.after(async () => { await client.destroy(); for (const session of sessions) session.destroy(); await new Promise(resolve => server.close(resolve)); });
  const timeout = assert.rejects(client.request({ path: "/held", method: "GET" }), error => error.code === "UND_ERR_HEADERS_TIMEOUT");
  await heldReceived;
  const recovery = client.request({ path: "/healthy", method: "GET", headersTimeout: 2_000 });
  await timeout;
  const response = await recovery;
  assert.equal(response.statusCode, 200);
  assert.equal(await response.body.text(), "recovered");
  assert.ok(pingCount >= 1, "a stream timeout must probe connection liveness before resuming queued work");
  assert.equal(sessionCount, 1, "a healthy HTTP/2 session remains reusable");
});
