import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

test("background mode reuses sign-ins across restart and bypasses desktop IPC only when enabled", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-background-browser-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldToken = process.env.PI_DESKTOP_TOKEN;
  const oldSend = process.send, oldProfile = process.env.PIORA_RUNTIME_PROFILE;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_DESKTOP_TOKEN = "isolated-test";
  process.env.PIORA_RUNTIME_PROFILE = "desktop";
  let desktopRequests = 0;
  process.send = (message) => {
    desktopRequests++;
    queueMicrotask(() => process.emit("message", { type: "pi-desktop:browser-response", requestId: message.requestId, ok: true, result: { content: [{ type: "text", text: "native browser" }], details: {} } }));
    return true;
  };
  const server = createServer((request, response) => {
    if (request.url === "/login") response.setHeader("Set-Cookie", "piora_test_login=signed-in; Path=/; HttpOnly");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<title>Account</title><h1>${request.headers.cookie?.includes("piora_test_login=signed-in") ? "Authenticated" : "Login"}</h1>`);
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const jiti = createJiti(import.meta.url);
    const { readBrowserConfig, writeBrowserConfig } = await jiti.import("./browser-config.ts");
    const extension = await jiti.import("../extensions/piora-browser.ts");
    let tool;
    extension.default({ registerTool(value) { tool = value; }, on() {} });
    const execute = (params) => tool.execute("test", params, undefined, undefined, { sessionManager: { getSessionId: () => "background-test" } });
    assert.deepEqual(readBrowserConfig(), { mode: "builtin" });
    await execute({ action: "tabs" });
    assert.equal(desktopRequests, 1);
    assert.throws(() => writeBrowserConfig({ mode: "system-chrome" }));
    writeBrowserConfig({ mode: "background" });
    assert.deepEqual(readBrowserConfig(), { mode: "background" });
    await execute({ action: "open", url: `${url}/login` });
    await execute({ action: "evaluate", text: "localStorage.setItem('saved-login', 'yes')" });
    await execute({ action: "open", url: `${url}/account` });
    assert.match(JSON.stringify(await execute({ action: "snapshot" })), /Authenticated/);
    const runtime = globalThis.__pioraBrowserRuntime;
    const context = await runtime.contextPromise;
    assert.match(await context.pages()[0].evaluate(() => navigator.userAgent), /HeadlessChrome/, "production launcher must not open a desktop window");
    const snapshot = JSON.parse(await readFile(path.join(root, "piora/browser-profile/piora-storage-state.json"), "utf8"));
    assert.ok(snapshot.cookies.some((cookie) => cookie.name === "piora_test_login" && cookie.expires === -1));
    // Force the session-cookie recovery path, instead of relying on Chromium's exit behavior.
    await context.clearCookies();
    if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
    await runtime.persistChain;
    await context.close();
    await execute({ action: "open", url: `${url}/account` });
    assert.match(JSON.stringify(await execute({ action: "snapshot" })), /Authenticated/);
    assert.match(JSON.stringify(await execute({ action: "evaluate", text: "localStorage.getItem('saved-login')" })), /yes/);
    assert.equal(desktopRequests, 1, "background actions must not reach the embedded browser");
    writeBrowserConfig({ mode: "builtin" });
    await execute({ action: "tabs" });
    assert.equal(desktopRequests, 2);
    writeBrowserConfig({ mode: "background" });
    assert.match(JSON.stringify(await execute({ action: "snapshot" })), /Authenticated/, "switching back preserves the background tab");
    await writeFile(path.join(root, "piora/browser.json"), '{"mode":"system-chrome"}');
    assert.deepEqual(readBrowserConfig(), { mode: "builtin" }, "obsolete settings retain the current default");
  } finally {
    const runtime = globalThis.__pioraBrowserRuntime;
    if (runtime?.persistTimer) clearTimeout(runtime.persistTimer);
    await runtime?.persistChain;
    await (await runtime?.contextPromise)?.close();
    process.send = oldSend;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", oldDir], ["PI_DESKTOP_TOKEN", oldToken], ["PIORA_RUNTIME_PROFILE", oldProfile]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
