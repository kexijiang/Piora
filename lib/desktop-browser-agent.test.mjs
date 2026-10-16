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
