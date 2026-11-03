import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { readAnswerOutput, answerOutputSnapshot, isAnswerOutputBlock } = await createJiti(import.meta.url).import("./answer-output.ts");

const output = { kind: "intelligent-ui", version: 1, snapshot: "Total: 42", payload: { nodes: [] } };
test("saved answer envelopes keep their fallback across unknown renderer versions", () => {
  for (const value of [output, { ...output, version: 2 }, { ...output, kind: "future-module" }]) {
    assert.deepEqual(readAnswerOutput({ answerOutput: value }), value);
    assert.equal(answerOutputSnapshot({ details: { answerOutput: value } }), "Total: 42");
  }
});

test("malformed output and failures use ordinary saved tool text", () => {
  for (const value of [null, [], { ...output, version: 0 }, { ...output, version: NaN }, { ...output, snapshot: {} }, { ...output, kind: "../module" }, { ...output, snapshot: "x".repeat(128_001) }]) {
    assert.equal(readAnswerOutput({ answerOutput: value }), null);
    assert.equal(answerOutputSnapshot({ details: { answerOutput: value }, content: [{ type: "text", text: "safe fallback" }] }), "safe fallback");
  }
  assert.equal(answerOutputSnapshot({ isError: true, details: { answerOutput: output }, content: [{ type: "text", text: "Validation failed" }] }), "Validation failed");
  assert.equal(answerOutputSnapshot(), "");
});

test("ordinary tools cannot opt themselves out of process disclosure", () => {
  assert.equal(isAnswerOutputBlock({ type: "toolCall", toolName: "piora_render_ui" }), true);
  for (const toolName of ["bash", "read", "piora_render_ui_extra", "render_ui"]) {
    assert.equal(isAnswerOutputBlock({ type: "toolCall", toolName }), false);
  }
  assert.equal(isAnswerOutputBlock({ type: "text", text: "piora_render_ui" }), false);
});
