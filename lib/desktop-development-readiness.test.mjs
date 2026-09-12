import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
const { developmentPageAssets, waitForDevelopmentPageAssets } = await createJiti(import.meta.url).import("../desktop/src/development-readiness.ts");

const html = '<script src="/_next/static/chunks/webpack.js?v=1&amp;dpl=fixture"></script><script src="/_next/static/chunks/app/page.js"></script><link rel="stylesheet" href="/_next/static/css/app/layout.css">';
const options = { headers: { "x-pi-desktop-token": "fixture-token" }, timeoutMs: 2_000, requestTimeoutMs: 500, retryIntervalMs: 5 };

async function fixture(t, handler) {
  const requests = [];
  const server = createServer((request, response) => { requests.push(request); handler(request, response); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, url: new URL(`http://127.0.0.1:${server.address().port}/`) };
}

function asset(response, path) {
  response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "application/javascript");
  response.end(path.endsWith(".css") ? "body{margin:0}" : "self.fixtureLoaded=true;");
}

test("readiness only loads actual same-origin Next scripts/styles and decodes query entities", () => {
  const url = new URL("http://127.0.0.1:30141/");
  const assets = developmentPageAssets(html + html + `
    <script src="https://foreign.invalid/_next/static/foreign.js"></script>
    <script src="http://name:secret@127.0.0.1:30141/_next/static/foreign.js"></script>
    <script src="http://127.0.0.1:30142/_next/static/foreign.js"></script>
    <script data-src="/_next/static/fake.js"></script>
    <script src="/api/should-not-load.js"></script>
    <link rel="preload" href="/_next/static/should-not-load.js">
    <link href='/icons/icon.png' rel='icon'>`, url);
  assert.deepEqual(assets.map(asset => asset.pathname + asset.search), [
    "/_next/static/chunks/webpack.js?v=1&dpl=fixture",
    "/_next/static/chunks/app/page.js", "/_next/static/css/app/layout.css",
  ]);
});

test("an open port and received script headers do not release the page before its body finishes", async t => {
  let pageRequests = 0, releaseChunk, chunkRequested;
  const requested = new Promise(resolve => { chunkRequested = resolve; });
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers["x-pi-desktop-token"], "fixture-token");
    if (request.url === "/") {
      if (++pageRequests === 1) { response.writeHead(503); response.end("Compiling"); return; }
      response.setHeader("Content-Type", "text/html"); response.end(html); return;
    }
    if (request.url.endsWith("/app/page.js")) {
      response.setHeader("Content-Type", "application/javascript");
      response.write("self.fixtureLoaded=");
      releaseChunk = () => response.end("true;");
      chunkRequested(); return;
    }
    asset(response, new URL(request.url, f.url).pathname);
  });
  let ready = false;
  const pending = waitForDevelopmentPageAssets(f.url, options).then(result => { ready = true; return result; });
  await requested;
  await delay(20);
  assert.equal(ready, false);
  releaseChunk();
  const result = await pending;
  assert.equal(result.assets, 3);
  assert.equal(result.attempts, 2);
  assert.ok(f.requests.some(request => request.url.includes("?v=1&dpl=fixture")));
});

test("a transient missing chunk and an HTML error served as a stylesheet are retried", async t => {
  let scripts = 0, styles = 0;
  const f = await fixture(t, (request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
    if (request.url.endsWith("/app/page.js") && ++scripts === 1) { response.writeHead(404); response.end("Compiling"); return; }
    if (request.url.endsWith(".css") && ++styles === 1) { response.setHeader("Content-Type", "text/html"); response.end("Error page"); return; }
    asset(response, new URL(request.url, f.url).pathname);
  });
  const result = await waitForDevelopmentPageAssets(f.url, options);
  assert.ok(result.attempts >= 2);
  assert.ok(scripts >= 2 && styles >= 2);
});

test("an authentication error is terminal and never includes the token in diagnostics", async t => {
  const f = await fixture(t, (_request, response) => { response.writeHead(403); response.end("Denied"); });
  await assert.rejects(waitForDevelopmentPageAssets(f.url, options), error => {
    assert.match(error.message, /authentication \(HTTP 403\)/);
    assert.doesNotMatch(error.stack, /fixture-token/); return true;
  });
  assert.equal(f.requests.length, 1);
});

test("readiness never follows a redirect or passes desktop authentication to a different origin", async t => {
  const other = await fixture(t, (_request, response) => { response.end("unexpected"); });
  const f = await fixture(t, (_request, response) => { response.writeHead(302, { Location: other.url.href }); response.end(); });
  await assert.rejects(waitForDevelopmentPageAssets(f.url, { ...options, timeoutMs: 100 }), /did not become ready/);
  assert.equal(other.requests.length, 0);
});

test("a script body that never finishes is bounded by the overall deadline", async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
    response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "application/javascript");
    response.write("/* loading */");
  });
  await assert.rejects(waitForDevelopmentPageAssets(f.url, { ...options, timeoutMs: 100 }), /did not become ready within 100ms/);
});

test("a placeholder HTML page without scripts never reports success", async t => {
  const f = await fixture(t, (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<h1>Starting</h1>"); });
  await assert.rejects(waitForDevelopmentPageAssets(f.url, { ...options, timeoutMs: 100 }), /did not become ready/);
});

test("non-loopback readiness URLs are rejected before any request", async () => {
  await assert.rejects(waitForDevelopmentPageAssets(new URL("https://outside.invalid/"), options), /loopback URL/);
});
