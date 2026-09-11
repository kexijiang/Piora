import assert from "node:assert/strict";
import test from "node:test";

const subject = await import("./command-execution.ts");

test("recognizes built-in shell tools without classifying unrelated tools", () => {
  assert.equal(subject.isCommandToolName("bash"), true);
  assert.equal(subject.isCommandToolName("bash (local)"), true);
  assert.equal(subject.isCommandToolName("powershell"), true);
  assert.equal(subject.isCommandToolName("powershell remote"), true);
  assert.equal(subject.isCommandToolName("bashful"), false);
});

test("derives terminal states and exit codes from command results", () => {
  const result = (text, isError = false, isStreaming = false) => ({
    role: "toolResult", toolCallId: "tool", content: [{ type: "text", text }], isError, isStreaming,
  });
  assert.equal(subject.commandStatus(undefined), "running");
  assert.equal(subject.commandStatus(result("still working", false, true)), "running");
  assert.equal(subject.commandStatus(result("ok")), "success");
  assert.equal(subject.commandStatus(result("Command timed out after 10 seconds", true)), "timed_out");
  assert.equal(subject.commandStatus(result("Command aborted", true)), "cancelled");
  assert.equal(subject.commandStatus(result("bad\n\nCommand exited with code 17", true)), "failed");
  assert.equal(subject.parseCommandExitCode("bad\nCommand exited with code 17"), 17);
  assert.equal(subject.commandExitCode(result("ok")), 0);
  assert.equal(subject.commandExitCode(result("bad", true)), undefined);
  assert.equal(subject.commandExitCode(result("bad\nCommand exited with code 17", true)), 17);
});

test("preserves truncation metadata and extracts a concise actionable error", () => {
  const result = {
    role: "toolResult", toolCallId: "tool", isError: true,
    content: [{ type: "text", text: "checking\nsrc/app.ts(4): error TS2322: wrong type\n  detail\nCommand exited with code 2" }],
    details: { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-a.log" },
  };
  assert.deepEqual(subject.commandResultMetadata(result), { truncated: true, fullOutputPath: "/tmp/pi-bash-a.log" });
  assert.equal(subject.commandErrorExcerpt(subject.toolResultText(result)), "src/app.ts(4): error TS2322: wrong type\n  detail");
});

test("restores streamed shell metadata without overwriting final fields", () => {
  const streamed = { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-a.log", source: "stream" };
  assert.deepEqual(subject.mergeCommandOutputDetails("bash", streamed, { source: "final" }), {
    truncation: { truncated: true },
    fullOutputPath: "/tmp/pi-bash-a.log",
    source: "final",
  });
  assert.deepEqual(subject.mergeCommandOutputDetails("powershell", streamed, undefined), streamed);
  assert.equal(subject.mergeCommandOutputDetails("custom_tool", streamed, undefined), undefined);
});
