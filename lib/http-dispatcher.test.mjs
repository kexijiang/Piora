import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

test("configures HTTP_PROXY, HTTPS_PROXY, and NO_PROXY for global fetch", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  const connectTargets = [];
  const forwardedRequests = [];
  const proxy = createServer((req, res) => {
    forwardedRequests.push({ url: req.url, host: req.headers.host });
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve, reject) => {
      proxy.close((error) => error ? reject(error) : resolve());
    });
  });

  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "bypass.invalid";

  const jiti = createJiti(import.meta.url);
  const { configureHttpDispatcher, applyNetworkProxySettings } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  assert.throws(() => configureHttpDispatcher(-1), /Invalid HTTP idle timeout/);
  configureHttpDispatcher(2_000);

  const dispatcher = getGlobalDispatcher();
  configureHttpDispatcher(5_000);
  assert.equal(getGlobalDispatcher(), dispatcher, "configuration should be idempotent");

  const httpResponse = await fetch("http://target.invalid/through-http-proxy", {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(httpResponse.status, 204);
  assert.deepEqual(connectTargets, []);
  assert.deepEqual(forwardedRequests, [{
    url: "http://target.invalid/through-http-proxy",
    host: "target.invalid",
  }]);

  await assert.rejects(fetch("https://target.invalid/through-https-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.deepEqual(connectTargets, ["target.invalid:443"]);

  const proxiedRequestCount = connectTargets.length + forwardedRequests.length;
  await assert.rejects(fetch("http://bypass.invalid:9/no-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.equal(connectTargets.length + forwardedRequests.length, proxiedRequestCount);

  const proxySettings = { mode: "system", proxyUrl: "", bypass: "" };
  applyNetworkProxySettings(proxySettings, 0);
  const unlimited = getGlobalDispatcher();
  assert.notEqual(unlimited, dispatcher, "changing only timeout must rebuild the dispatcher");
  applyNetworkProxySettings(proxySettings, 0);
  assert.equal(getGlobalDispatcher(), unlimited, "unchanged timeout and proxy reuse the dispatcher");
  applyNetworkProxySettings(proxySettings, 600000);
  assert.notEqual(getGlobalDispatcher(), unlimited, "longer configured deadlines must also apply");
  await getGlobalDispatcher().close();
});

test("transport reads saved unlimited and extended deadlines at startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-http-settings-"));
  const file = path.join(root, "settings.json");
  try {
    const { readConfiguredHttpIdleTimeoutMs } = await createJiti(import.meta.url).import("./http-dispatcher.ts");
    for (const timeout of [0, 900000]) {
      await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: timeout }));
      assert.equal(readConfiguredHttpIdleTimeoutMs(file), timeout);
    }
    await writeFile(file, "{}");
    assert.equal(readConfiguredHttpIdleTimeoutMs(file), 300000);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("piora-http-settings-"));
    await rm(root, { recursive: true, force: true });
  }
});
