import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createJiti } from "jiti";

const { formatStatusDuration } = await createJiti(import.meta.url).import("../lib/status-duration.ts");
const source = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
// Render the actual chat-page condition and status component with controlled
// stream/clock inputs. No model or wall-clock wait is needed for a 300s gap.
const status = source.slice(source.indexOf("const STATUS_STALL_AFTER_MS"), source.indexOf("const CHAT_MINIMAP_WIDTH"));
const region = source.slice(source.indexOf("            {agentRunning &&"), source.indexOf('            {visionStatus?.phase === "failed"'));
assert.ok(status.includes("function StatusPulse") && region.includes("<StatusPulse"));
const js = ts.transpileModule(`${status}\nfunction render(){return <>${region}</>}`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function render(overrides = {}) {
  const env = {
    React, formatStatusDuration, agentRunning: true, agentPhase: { kind: "waiting_model" },
    streamState: { streamingMessage: { role: "assistant", content: [{ type: "text", text: "partial reply" }] } },
    visionStatus: null, compactProcess: false, browserWaiting: false, statusElapsedMs: 301000,
    statusIdleMs: 300000, retryInfo: null,
    phaseLabel: () => "Waiting for model",
    t: (key, params) => `${key}${params ? ` ${Object.values(params).join(" ")}` : ""}`,
    ...overrides,
  };
  return renderToStaticMarkup(new Function("env", `with(env){${js};return render();}`)(env)).trim();
}

test("a stalled partial stream exposes elapsed and no-progress feedback", () => {
  const html = render();
  assert.match(html, /role="status"/);
  assert.match(html, /chat.statusElapsed/);
  assert.match(html, /chat.statusIdle/);
});

test("active output, completion and vision failure do not show a stale waiting line", () => {
  assert.equal(render({ statusIdleMs: 1000 }), "");
  assert.equal(render({ agentRunning: false }), "");
  assert.equal(render({ visionStatus: { phase: "failed" } }), "");
  assert.match(render({ streamState: { streamingMessage: null }, statusIdleMs: 1000 }), /chat.statusElapsed/);
  assert.match(render({ agentPhase: { kind: "stopping" }, statusIdleMs: 1000 }), /role="status"/);
});
