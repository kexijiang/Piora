import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve from the unchanged CLI entrypoint, so a stale nested install cannot
// pass by testing only the root dependency.
const cliRequire = createRequire(new URL("../node_modules/@deveco/deveco-cli/dist/cli.js", import.meta.url));
const axios = cliRequire("axios");

test("DevEco CLI resolves the fixed Axios and preserves Node HTTP requests and cancellation", async t => {
  assert.equal(axios.VERSION, "1.20.0");
  const server = createServer((request, response) => {
    if (request.url === "/slow") return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const client = axios.create({ baseURL, proxy: false, timeout: 1000 });
  const response = await client.get("/check", { params: { product: "default" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { method: "GET", path: "/check?product=default" });
  await assert.rejects(client.get("/slow", { signal: AbortSignal.timeout(25) }), error => axios.isCancel(error));
});
