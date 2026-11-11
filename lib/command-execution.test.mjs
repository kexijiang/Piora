import assert from "node:assert/strict";
import test from "node:test";

const subject = await import("./command-execution.ts");

test("command action labels recognize common inspection chains and keep unknown scripts neutral", () => {
  assert.equal(subject.commandActionKey('cd /project && ls -F && echo "---" && git log --oneline -5 && wc -l README.md'), "command.action.inspect");
  assert.equal(subject.commandActionKey('head -60 README.md'), "command.action.read");
  assert.equal(subject.commandActionKey('rg "test && ls" src'), "command.action.search");
  assert.equal(subject.commandActionKey('npm run test'), "command.action.test");
  assert.equal(subject.commandActionKey('git reset --hard'), "command.action.run");
  assert.equal(subject.commandActionKey('python script.py'), "command.action.run");
  assert.equal(subject.commandActionKey('npm test && cat output.txt'), "command.action.run");
});

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

test("structured exit codes settle conflicting flags and nonzero success output remains a warning", () => {
  const result = (text, isError = false) => ({ role: "toolResult", toolCallId: "tool", content: [{ type: "text", text }], isError });
  const zero = { ...result("BUILD SUCCESSFUL in 3 min\n0", true), details: { exitCode: 0 } };
  assert.equal(subject.commandExitCode(zero), 0);
  assert.equal(subject.commandStatus(zero), "success");
  const warning = { ...result("BUILD SUCCESSFUL in 3 min\nCommand exited with code 1", true), details: { exitCode: 1 } };
  assert.equal(subject.commandStatus(warning), "warning");
  assert.equal(subject.commandExitCode(warning), 1);
  assert.equal(subject.commandStatus({ ...warning, content: [{ type: "text", text: "BUILD FAILED\nCommand exited with code 1" }] }), "failed");
  assert.equal(subject.commandStatus({ ...warning, isError: false }), "warning", "a success flag cannot hide a known nonzero exit");
  assert.equal(subject.commandStatus({ ...warning, isStreaming: true }), "running");
  assert.equal(subject.commandStatus({ ...warning, details: { exitCode: 1, timedOut: true } }), "timed_out");
  assert.equal(subject.commandStatus({ ...warning, details: { exitCode: 1, cancelled: true } }), "cancelled");
  assert.equal(subject.commandStatus(result("BUILD SUCCESSFUL\n0", true)), "warning", "conflicting evidence remains a warning, never a guessed success");
  assert.equal(subject.commandExitCode(result("BUILD SUCCESSFUL\n0", true)), undefined);
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

test("build error lines preserve task context without highlighting zero-error summaries", () => {
  assert.equal(subject.isCommandErrorLine("\u001b[31mERROR :entry:default@CompileArkTS failed\u001b[0m"), true);
  assert.equal(subject.isCommandErrorLine("Build finished with 0 errors"), false);
  assert.equal(subject.isCommandErrorLine("No errors found"), false);
  assert.equal(subject.isCommandErrorLine("Compiling entry"), false);
});
