import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getAssistantErrorMessage,
  getDisplayableAssistantBlocks,
  isEmptyThinkingBlock,
  splitFinalAssistantBlocks,
} from "./message-display.ts";
import { summarizeToolCall } from "./tool-summary.ts";

const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const appShell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const harmonyPanel = readFileSync(new URL("../components/workspace/HarmonyPanel.tsx", import.meta.url), "utf8");
const rightPanel = readFileSync(new URL("../components/workspace/RightPanel.tsx", import.meta.url), "utf8");
const agentSession = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const toolSummary = readFileSync(new URL("./tool-summary.ts", import.meta.url), "utf8");

test("versions desktop client assets and avoids server navigation for local task selection", () => {
  assert.match(nextConfig, /const deploymentId = `piora-\$\{version\.replace/);
  assert.match(nextConfig, /deploymentId,/);
  assert.doesNotMatch(appShell, /useRouter|router\.replace/);
  assert.match(appShell, /replaceUrlWithoutNextNavigation/);
  assert.match(appShell, /__NA: true/);
  assert.doesNotMatch(appShell, /history\.replaceState\(window\.history\.state/);
});

test("isolates Harmony rendering and normalizes untrusted runtime payloads", () => {
  assert.match(rightPanel, /<SafeHarmonyPanel/);
  assert.match(harmonyPanel, /class HarmonyPanelErrorBoundary/);
  assert.match(harmonyPanel, /function normalizeDevices\(value: unknown\)/);
  assert.match(harmonyPanel, /function normalizeHarmonyState\(value: unknown/);
  assert.match(harmonyPanel, /Array\.isArray\(payloadRecord\?\.devices\)/);
  assert.doesNotMatch(harmonyPanel, /devicePayload\.devices\.some/);
});

test("mounting a running session does not try to mutate its active tool set", () => {
  const mountEffect = agentSession.match(/\/\/ Load session on mount([\s\S]*?)useEffect\(\(\) => \{\r?\n    onSystemPromptChange/);
  assert.ok(mountEffect, "session mount effect should remain discoverable");
  assert.doesNotMatch(mountEffect[1], /set_capabilities/);
  assert.match(agentSession, /case "reload":[\s\S]*?type: "get_capabilities"/);
});

test("partial streaming tool inputs cannot crash chat rendering", () => {
  assert.match(toolSummary, /typeof value !== "string"/);
  assert.match(toolSummary, /typeof call\.input\.content === "string"/);
  assert.match(toolSummary, /const safeName = typeof name === "string"/);
});
// ── Behavioral guards: malformed session content and streaming fragments ──

test("malformed restored session content cannot crash message flattening", () => {
  const missingContent = { role: "assistant", content: undefined };
  assert.deepEqual(getDisplayableAssistantBlocks(missingContent), []);
  assert.deepEqual(splitFinalAssistantBlocks(missingContent), { answerBlocks: [], processBlocks: [] });

  const stringContent = { role: "assistant", content: "not-an-array" };
  assert.deepEqual(getDisplayableAssistantBlocks(stringContent), []);

  // A thinking block whose text never arrived must render, not crash.
  const missingThinking = { type: "thinking", thinking: undefined, deferred: false };
  assert.equal(isEmptyThinkingBlock(missingThinking, {}), false);
  const emptyThinking = { type: "thinking", thinking: "", deferred: false };
  assert.equal(isEmptyThinkingBlock(emptyThinking, {}), true);

  assert.equal(
    getAssistantErrorMessage({ role: "assistant", stopReason: "error", errorMessage: undefined }),
    "Unknown provider error",
  );
});

test("DeepSeek fragmented tool-call streaming cannot crash tool summaries", () => {
  const t = (key, variables) => key + " " + JSON.stringify(variables ?? {});
  // Argument payloads observed mid-stream: fragments arrive as undefined,
  // partial records, empty strings, or non-object values before the model
  // finishes emitting the tool call.
  const fragmentStates = [
    undefined,
    null,
    {},
    { content: undefined },
    { content: "" },
    { content: "hello" },
    { content: 42 },
    { content: { nested: true } },
    { path: undefined, content: "x" },
    "not-an-object",
    7,
  ];
  const resultStates = [
    undefined,
    null,
    {},
    { content: undefined, isError: true },
    { content: [{ type: "text", text: "done" }] },
    { content: [{ type: "text", text: "done" }], details: { patch: { bad: true } } },
  ];

  for (const name of ["write", "bash", "edit", "read", "grep", "find", "ls", undefined, { weird: true }]) {
    for (const input of fragmentStates) {
      for (const result of resultStates) {
        const summary = summarizeToolCall(name, input, result, t);
        assert.equal(typeof summary.title, "string", JSON.stringify({ name, input, result }));
        assert.equal(typeof summary.status, "string");
        assert.ok(summary.detail === undefined || typeof summary.detail === "string");
      }
    }
  }

  // A non-string bash command must degrade to an empty detail instead of
  // throwing, and a partial grep pattern must still produce a title.
  const bashSummary = summarizeToolCall("bash", { command: 42 }, undefined, t);
  assert.ok(bashSummary.detail === undefined || typeof bashSummary.detail === "string");
  const grepSummary = summarizeToolCall("grep", { pattern: undefined, path: undefined }, undefined, t);
  assert.equal(typeof grepSummary.title, "string");
  assert.ok(grepSummary.detail === undefined || typeof grepSummary.detail === "string");
});

test("message rendering defends against malformed restored content", () => {
  const minimap = readFileSync(new URL("../components/ChatMinimap.tsx", import.meta.url), "utf8");
  const messageView = readFileSync(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  const chatWindow = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const statusBar = readFileSync(new URL("../components/ExtensionStatusBar.tsx", import.meta.url), "utf8");

  assert.match(minimap, /Array\.isArray\(message\.content\)/);
  assert.match(messageView, /Array\.isArray\(message\.content\)/);
  assert.match(messageView, /Array\.isArray\(result\.content\)/);
  assert.match(messageView, /typeof text !== "string"/);
  assert.match(chatWindow, /typeof block\.text === "string"/);
  assert.match(chatWindow, /Array\.isArray\(message\.content\)/);
  assert.match(statusBar, /typeof text !== "string"/);
  assert.match(statusBar, /!Array\.isArray\(statuses\)/);
});

test("per-message error boundary keeps one bad message from killing the page", () => {
  const boundary = readFileSync(new URL("../components/RenderErrorBoundary.tsx", import.meta.url), "utf8");
  const chatWindow = readFileSync(new URL("../components/ChatHistory.tsx", import.meta.url), "utf8");

  assert.match(boundary, /class RenderErrorBoundary extends Component/);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /componentDidUpdate/);
  assert.match(boundary, /data-render-fallback/);
  assert.match(chatWindow, /<RenderErrorBoundary/);
  assert.match(chatWindow, /resetKey=\{messageFingerprint\(message, entryIds\[index\]\)\}/);
  assert.match(chatWindow, /messageRenderFailed/);
});

test("workspace panels are isolated so an open Harmony panel cannot reload the app", () => {
  const rightPanel = readFileSync(new URL("../components/workspace/RightPanel.tsx", import.meta.url), "utf8");
  assert.match(rightPanel, /<SafeHarmonyPanel/);
  assert.match(rightPanel, /resetKey=\{`harmony:\$\{refreshKey\}`\}/);
  assert.match(rightPanel, /resetKey=\{`review:\$\{refreshKey\}`\}/);
  assert.match(rightPanel, /resetKey=\{`files:\$\{refreshKey\}`\}/);
  assert.match(rightPanel, /workspace\.panelRenderFailed/);
});
