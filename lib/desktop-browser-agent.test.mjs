import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { selectBrowserBackend } = await jiti.import("./browser-backend.ts");
const { readAgentBrowserMode } = await jiti.import("./browser-mode.ts");
const bridge = await jiti.import("./desktop-browser-agent.ts");

test("desktop backend is selected only for a connected builtin browser", () => {
  assert.equal(selectBrowserBackend({ desktopIpc: true, mode: "builtin" }), "desktop");
  assert.equal(selectBrowserBackend({ desktopIpc: true, mode: "background" }), "playwright");
  assert.equal(selectBrowserBackend({ desktopIpc: false, mode: "builtin" }), "playwright");
  assert.equal(selectBrowserBackend({ desktopIpc: false, mode: "background" }), "playwright");
});

test("a missing browser mode file stays on the built-in browser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-browser-mode-"));
  try {
    assert.equal(readAgentBrowserMode(root), "builtin");
    await mkdir(path.join(root, "piora"), { recursive: true });
    await writeFile(path.join(root, "piora", "browser.json"), JSON.stringify({ mode: "background" }));
    assert.equal(readAgentBrowserMode(root), "background");
    await writeFile(path.join(root, "piora", "browser.json"), "{");
    assert.equal(readAgentBrowserMode(root), "builtin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop evaluate confirmation shows the page URL and a truncated script, and long results use the snapshot cap", () => {
  const script = `${"s".repeat(bridge.EVALUATE_SCRIPT_PREVIEW_CHARS)}TAIL`;
  const message = bridge.evaluateConfirmText(script, "https://accounts.example/login");
  assert.match(message, /https:\/\/accounts\.example\/login/);
  assert.match(message, new RegExp(`s{${bridge.EVALUATE_SCRIPT_PREVIEW_CHARS}}…`));
  assert.equal(message.includes("TAIL"), false);
  assert.match(message, /Allow this once/);
  const unknown = bridge.evaluateConfirmText("document.title", "  ");
  assert.match(unknown, /unknown page/);
  assert.match(unknown, /document\.title/);
  assert.equal(bridge.pageUrlFromTabList({
    tabs: [
      { tabId: "other", url: "https://example.test/other", active: false },
      { tabId: "agent", url: "https://example.test/agent", active: true },
    ],
  }), "https://example.test/agent");
  assert.equal(bridge.pageUrlFromTabList({
    tabs: [{ tabId: "target", url: "https://example.test/target", active: false }],
  }, "target"), "https://example.test/target");
  assert.equal(bridge.pageUrlFromTabList(null), bridge.EVALUATE_UNKNOWN_PAGE);
  const capped = bridge.capSnapshotText("z".repeat(24_001), 24_000);
  assert.equal(capped.startsWith("z".repeat(24_000)), true);
  assert.match(capped, /\n… snapshot truncated$/);
  assert.equal(capped.includes("z".repeat(24_001)), false);
  assert.equal(bridge.capSnapshotText("short", 24_000), "short");
});

test("desktop evaluate is confirmed by the user, and a missing bridge falls back to playwright", async () => {
  assert.deepEqual(bridge.desktopEvaluateRequest({ hasUI: false, userConfirmed: true }), { error: bridge.DESKTOP_EVALUATE_DISABLED });
  assert.deepEqual(bridge.desktopEvaluateRequest({ hasUI: true, userConfirmed: false }), { error: bridge.DESKTOP_EVALUATE_DISABLED });
  assert.deepEqual(bridge.desktopEvaluateRequest({ hasUI: true, userConfirmed: true }), { confirmed: true });
  const seen = [];
  const fallback = await bridge.runBrowserBackend({
    desktop: true,
    onBackend: (backend) => seen.push(backend),
    runDesktop: async () => { throw new bridge.DesktopAgentBridgeUnavailable(); },
    runPlaywright: async () => "playwright-result",
  });
  assert.equal(fallback.backend, "playwright");
  assert.equal(fallback.value, "playwright-result");
  assert.deepEqual(seen, ["playwright"]);
  const direct = await bridge.runBrowserBackend({
    desktop: true,
    runDesktop: async () => "desktop-result",
    runPlaywright: async () => { throw new Error("playwright should not run"); },
  });
  assert.equal(direct.backend, "desktop");
  assert.equal(direct.value, "desktop-result");
  const web = await bridge.runBrowserBackend({
    desktop: false,
    runDesktop: async () => { throw new Error("desktop should not run"); },
    runPlaywright: async () => "web-result",
  });
  assert.equal(web.backend, "playwright");
  assert.equal(web.value, "web-result");
});

test("an aborted desktop browser call sends cancel and does not treat a pause as a bridge failure", async () => {
  const sent = [];
  const originalSend = process.send;
  const originalEnv = process.env.PIORA_DESKTOP_NETWORK_IPC;
  const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
  process.env.PIORA_DESKTOP_NETWORK_IPC = "1";
  Object.defineProperty(process, "connected", { configurable: true, get: () => true });
  process.send = (message, callback) => {
    sent.push(message);
    if (typeof callback === "function") callback(null);
    return true;
  };
  try {
    assert.equal(bridge.hasDesktopAgentBridge(), true);
    const controller = new AbortController();
    const pending = bridge.callDesktopAgentBrowser({ sessionId: "session-a", action: "snapshot", signal: controller.signal });
    const request = sent.find((message) => message.type === "pi-desktop:browser-agent-request");
    assert.equal(request.action, "snapshot");
    assert.equal(request.sessionId, "session-a");
    controller.abort();
    await assert.rejects(pending, /Browser action aborted/);
    assert.equal(sent.some((message) => message.type === "pi-desktop:browser-agent-cancel" && message.requestId === request.requestId), true);
    assert.equal(sent.some((message) => message.type === "pi-desktop:browser-agent-request" && message.action === "idle" && message.sessionId === "session-a"), true);
    const already = new AbortController();
    already.abort();
    sent.length = 0;
    await assert.rejects(bridge.callDesktopAgentBrowser({ sessionId: "session-a", action: "click", signal: already.signal }), /Browser action aborted/);
    assert.equal(sent.some((message) => message.type === "pi-desktop:browser-agent-cancel"), false);
    assert.equal(sent.some((message) => message.action === "idle" && message.sessionId === "session-a"), true);
    sent.length = 0;
    const waiting = new AbortController();
    const waitCall = bridge.callDesktopAgentBrowser({ sessionId: "session-a", action: "wait_begin", reason: "Sign in", signal: waiting.signal });
    waiting.abort();
    await assert.rejects(waitCall, /Browser action aborted/);
    assert.equal(sent.some((message) => message.type === "pi-desktop:browser-agent-cancel"), true);
    assert.equal(sent.some((message) => message.action === "idle"), false);
    assert.equal(bridge.isDesktopBridgeUnavailable(new Error("Browser agent is paused by user.")), false);
    assert.equal(bridge.isDesktopBridgeUnavailable(new bridge.DesktopAgentBridgeUnavailable()), true);
  } finally {
    if (originalSend === undefined) delete process.send;
    else process.send = originalSend;
    if (originalEnv === undefined) delete process.env.PIORA_DESKTOP_NETWORK_IPC;
    else process.env.PIORA_DESKTOP_NETWORK_IPC = originalEnv;
    if (originalConnected) Object.defineProperty(process, "connected", originalConnected);
    else delete process.connected;
  }
});
