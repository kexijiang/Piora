import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

test("desktop system proxy reaches the selected proxy and bypasses local app traffic", async () => {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "PIORA_DESKTOP_NETWORK_IPC"];
  const saved = keys.map(key => [key, process.env[key]]);
  const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
  const listeners = process.listeners("message");
  let tunnels = 0, forwarded = 0;
  const target = createServer((_req, res) => res.end("application response"));
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const proxy = createServer((_req, res) => { forwarded++; res.end("application response"); });
  proxy.on("connect", (_req, socket, head) => {
    tunnels++;
    const upstream = createConnection(target.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const resolutions = [];
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  Object.defineProperty(process, "send", { configurable: true, value: (message, callback) => {
    const value = message.action === "resolve" ? `PROXY 127.0.0.1:${proxy.address().port}` : true;
    if (message.action === "resolve") resolutions.push(message.value);
    queueMicrotask(() => process.emit("message", { type: "pi-desktop:network-response", requestId: message.requestId, ok: true, value }));
    callback?.(null); return true;
  } });
  for (const key of keys) delete process.env[key];
  process.env.PIORA_DESKTOP_NETWORK_IPC = "1";
  const { applyNetworkProxySettings } = await createJiti(import.meta.url).import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");
  try {
    applyNetworkProxySettings({ mode: "system", proxyUrl: "", bypass: "" }, 2000);
    assert.equal(await (await fetch("http://model.test/chat", { signal: AbortSignal.timeout(3000) })).text(), "application response");
    assert.equal(tunnels + forwarded, 1);
    assert.deepEqual(resolutions, ["http://model.test/chat"]);
    assert.equal(await (await fetch(`http://127.0.0.1:${target.address().port}/health`)).text(), "application response");
    assert.equal(tunnels + forwarded, 1);
    assert.equal(resolutions.length, 1);
    const bridge = await createJiti(import.meta.url).import("./desktop-network-proxy.ts");
    await bridge.applyDesktopProxySettings({ mode: "direct", proxyUrl: "", bypass: "" });
    assert.equal(bridge.systemProxyUrl("DIRECT"), undefined);
    assert.equal(bridge.systemProxyUrl("HTTPS proxy.test:8443; DIRECT"), "https://proxy.test:8443");
    assert.throws(() => bridge.systemProxyUrl("SOCKS5 proxy.test:1080; DIRECT"), /HTTP or HTTPS/);
  } finally {
    await getGlobalDispatcher().close();
    target.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (send) Object.defineProperty(process, "send", send); else delete process.send;
    if (connected) Object.defineProperty(process, "connected", connected); else delete process.connected;
    for (const listener of process.listeners("message")) if (!listeners.includes(listener)) process.removeListener("message", listener);
  }
});
