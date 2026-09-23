import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { reduceAgentTerminal, restoreAgentTerminal, downgradeUnconfirmedRunning } = await jiti.import("./agent-terminal.ts");
const { minimapPreviewTop } = await jiti.import("./minimap-position.ts");

test("Agent output uses cumulative snapshots and preserves command identity", () => {
  let commands = reduceAgentTerminal([], { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
  for (const text of ["one", "one\ntwo"]) commands = reduceAgentTerminal(commands, { type: "tool_execution_update", toolCallId: "a", partialResult: { content: [{ type: "text", text }] } });
  assert.equal(commands[0].output, "one\ntwo");
  commands = reduceAgentTerminal(commands, { type: "tool_execution_end", toolCallId: "a", isError: true, result: { content: [{ type: "text", text: "failed" }] } });
  assert.deepEqual(commands, [{ id: "a", command: "npm test", output: "failed", status: "failed" }]);
  assert.deepEqual(reduceAgentTerminal(commands, { type: "tool_execution_end", toolCallId: "other", result: {} }), commands);
});
test("history restores both SDK and normalized calls, manual commands, and keeps unresolved work running", () => {
  const restored = restoreAgentTerminal([
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "echo a" } }, { type: "toolCall", toolCallId: "b", toolName: "bash", input: { command: "echo b" } }] },
    { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "a" }] },
    { role: "bashExecution", command: "echo c", output: "c", exitCode: 0, timestamp: 1 },
  ]);
  assert.deepEqual(restored.map((item) => item.status), ["completed", "running", "completed"]);
  assert.deepEqual(restored.map((item) => item.output), ["a", "", "c"]);
  // The live registry decides: an id it still tracks stays running even after a
  // reload; an id it does not know (restart, old history) becomes interrupted.
  assert.deepEqual(
    downgradeUnconfirmedRunning(restored, new Set(["b"])).map((item) => item.status),
    ["completed", "running", "completed"],
  );
  assert.deepEqual(
    downgradeUnconfirmedRunning(restored, new Set()).map((item) => item.status),
    ["completed", "interrupted", "completed"],
  );
});
test("sparse timeline previews stay near the pointer and inside the container", () => {
  assert.equal(minimapPreviewTop(24, 120, 700), 8);
  assert.equal(minimapPreviewTop(220, 120, 700), 198);
  assert.equal(minimapPreviewTop(690, 120, 700), 572);
});
