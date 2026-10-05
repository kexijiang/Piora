import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("Agent browser switches application proxy while retaining tabs and sign-in storage", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-browser-proxy-"));
  const env = ["PI_CODING_AGENT_DIR", "PIORA_DESKTOP_DATA_DIR"].map(key => [key, process.env[key]]);
  process.env.PI_CODING_AGENT_DIR = directory; process.env.PIORA_DESKTOP_DATA_DIR = directory;
  const requests = [[], []];
  const proxies = requests.map((seen, index) => createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "text/html");
    res.end(`<title>Proxy ${index}</title><main>Proxy ${index}</main>`);
  }));
  for (const proxy of proxies) { proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); }
  try {
    const jiti = createJiti(import.meta.url);
    const { writeNetworkProxySettings, browserNetworkProxyOptions } = await jiti.import("./network-proxy.ts");
    assert.deepEqual(browserNetworkProxyOptions({ mode: "direct", proxyUrl: "", bypass: "" }), { args: ["--no-proxy-server"] });
    const authenticated = browserNetworkProxyOptions({ mode: "manual", proxyUrl: "http://user:pass@127.0.0.1:9000", bypass: "internal.test" });
    assert.equal(authenticated.proxy.server, "http://127.0.0.1:9000");
    assert.equal(authenticated.proxy.username, "user");
    let tool;
    const extension = await jiti.import("../extensions/piora-browser.ts");
    extension.default({ registerTool: value => { tool = value; }, on() {} });
    const context = { sessionManager: { getSessionId: () => "proxy-task" } };
    const execute = params => tool.execute("proxy-test", params, undefined, undefined, context);
    const setting = index => ({ mode: "manual", proxyUrl: `http://127.0.0.1:${proxies[index].address().port}`, bypass: "localhost,127.0.0.1,::1" });
    writeNetworkProxySettings(setting(0));
    await execute({ action: "open", url: "http://model.test/workspace" });
    await execute({ action: "evaluate", text: 'localStorage.setItem("login", "retained"); document.cookie="token=retained"' });
    assert.ok(requests[0].some(url => url === "http://model.test/workspace"));
    writeNetworkProxySettings(setting(1));
    const result = await execute({ action: "evaluate", text: '({title:document.title,login:localStorage.getItem("login"),cookie:document.cookie,url:location.href})' });
    const state = JSON.parse(result.content[0].text);
    assert.deepEqual(state, { title: "Proxy 1", login: "retained", cookie: "token=retained", url: "http://model.test/workspace" });
    assert.ok(requests[1].some(url => url === "http://model.test/workspace"));
  } finally {
    const runtime = globalThis.__pioraBrowserRuntime;
    if (runtime?.contextPromise) await (await runtime.contextPromise).close();
    await runtime?.persistChain;
    for (const proxy of proxies) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(dirname(directory), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});
