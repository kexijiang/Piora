import assert from "node:assert/strict";
import test from "node:test";
import { reduceAgentPhase } from "./agent-phase.ts";

test("tool results cannot hide other tools still executing", () => {
  let phase = reduceAgentPhase(null, { type: "agent_start" });
  phase = reduceAgentPhase(phase, { type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  phase = reduceAgentPhase(phase, { type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
  for (const type of ["message_start", "message_update", "message_end"]) {
    phase = reduceAgentPhase(phase, { type });
    assert.equal(phase.kind, "running_tools");
    assert.equal(phase.tools.length, 2);
  }
  phase = reduceAgentPhase(phase, { type: "tool_execution_end", toolCallId: "a" });
  phase = reduceAgentPhase(phase, { type: "message_end" });
  assert.deepEqual(phase, { kind: "running_tools", tools: [{ id: "b", name: "bash" }] });
  phase = reduceAgentPhase(phase, { type: "tool_execution_end", toolCallId: "b" });
  assert.deepEqual(phase, { kind: "waiting_model" });
  assert.equal(reduceAgentPhase(phase, { type: "message_update" }), null);
});

test("repeated tool starts and unrelated ends do not corrupt active tools", () => {
  const event = { type: "tool_execution_start", toolCallId: "a", toolName: "read" };
  const phase = reduceAgentPhase(null, event);
  assert.deepEqual(reduceAgentPhase(phase, event), phase);
  assert.deepEqual(reduceAgentPhase(phase, { type: "tool_execution_end", toolCallId: "other" }), phase);
  assert.equal(reduceAgentPhase(phase, { type: "agent_end" }), null);
});

test("late model and tool events cannot overwrite stopping", () => {
  const phase = { kind: "stopping" };
  for (const type of ["agent_start", "agent_end", "message_update", "message_end", "tool_execution_start", "tool_execution_end"]) {
    assert.equal(reduceAgentPhase(phase, { type, toolCallId: "late", toolName: "bash" }), phase);
  }
});
