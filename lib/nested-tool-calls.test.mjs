import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { NestedToolCallsStore } = await createJiti(import.meta.url).import("./nested-tool-calls.ts");
const event = (type, id, parent, extra = {}) => ({ type: `tool_execution_${type}`, toolCallId: id, parentToolCallId: parent, toolName: "fixture", ...extra });

test("parallel and nested calls update only their root subscribers, deduplicated and batched", () => {
  const store = new NestedToolCallsStore(); store.beginRun(1);
  let root = 0, other = 0;
  store.subscribe("root", () => root++); store.subscribe("other", () => other++);
  store.record(event("start", "root/0", "root"), 10);
  store.record(event("start", "root/1", "root"), 12);
  store.record(event("start", "root/0/0", "root/0"), 13);
  store.record(event("start", "root/0", "root"), 14);
  store.record(event("end", "root/1", "root", { isError: true, result: { content: [{ type: "text", text: "failed" }] } }), 20);
  store.record(event("update", "root/0", "root", { partialResult: { content: [{ type: "text", text: "large progress" }] } }));
  store.flush();
  assert.equal(root, 1); assert.equal(other, 0);
  assert.equal(store.getSnapshot("root").calls.length, 3);
  assert.equal(store.getSnapshot("root").calls[1].error, "failed");
  assert.equal(store.getSnapshot("root").calls[1].durationMs, 8);
  store.record(event("end", "root/1", "root", { isError: true }), 100);
  assert.equal(store.getSnapshot("root").calls[1].durationMs, 8, "duplicate ends preserve the original duration and error");
  store.record(event("end", "root/0/0", "root/0"), 22);
  store.finish(); store.flush();
  assert.deepEqual(store.getSnapshot("root").calls.map(call => call.status), ["unfinished", "error", "ok"]);
  assert.equal(store.getSnapshot("root").complete, false);
  store.record(event("end", "root/0", "root"), 120);
  assert.equal(store.getSnapshot("root").calls[0].status, "unfinished", "late completion cannot rewrite a settled run");
  store.beginRun(2); assert.equal(store.getSnapshot("root"), undefined);
  store.reset();
});

test("missing starts and oversized runs remain visibly incomplete", () => {
  const store = new NestedToolCallsStore(); store.beginRun(1);
  store.record(event("end", "r/0", "r"));
  store.record(event("start", "r/0", "r"));
  assert.equal(store.getSnapshot("r").calls[0].status, "ok");
  assert.equal(store.getSnapshot("r").complete, false);
  for (let i = 1; i < 300; i++) store.record(event("start", `r/${i}`, "r"));
  assert.equal(store.getSnapshot("r").calls.length, 256);
  store.reset();
});

test("nested PowerShell output is visible before completion, bounded and never duplicated", () => {
  const store = new NestedToolCallsStore(); store.beginRun(1);
  store.record(event("start", "r/ps", "r", { toolName: "powershell", args: { command: "hvigorw assembleHap" } }), 1);
  const update = text => store.record(event("update", "r/ps", "r", { toolName: "powershell", partialResult: { content: [{ type: "text", text }] } }));
  update("compile started"); update("compile started\n:entry:default@CompileArkTS ERROR fixture");
  let call = store.getSnapshot("r").calls[0];
  assert.equal(call.status, "running");
  assert.equal(call.command, "hvigorw assembleHap");
  assert.equal(call.output, "compile started\n:entry:default@CompileArkTS ERROR fixture");
  update("x".repeat(70000));
  call = store.getSnapshot("r").calls[0];
  assert.equal(call.output.length, 64000); assert.equal(call.outputTruncated, true);
  store.record(event("end", "r/ps", "r", { toolName: "powershell", isError: true, result: { content: [{ type: "text", text: "ERROR compile failed" }] } }), 10);
  update("late output");
  call = store.getSnapshot("r").calls[0];
  assert.equal(call.output, "ERROR compile failed"); assert.equal(call.status, "error"); assert.equal(call.durationMs, 9);
  store.finish(); store.reset();
});

test("non-command partial results and missing starts do not retain arbitrary output", () => {
  const store = new NestedToolCallsStore(); store.beginRun(1);
  store.record(event("update", "r/missing", "r", { toolName: "bash", partialResult: { content: [{ type: "text", text: "missing" }] } }));
  assert.equal(store.getSnapshot("r"), undefined);
  store.record(event("start", "r/read", "r", { toolName: "read" }));
  store.record(event("update", "r/read", "r", { partialResult: { content: [{ type: "text", text: "not a command" }] } }));
  assert.equal(store.getSnapshot("r").calls[0].output, undefined);
  store.reset();
});

test("real child-process output reaches the SDK progress callback before command exit", async () => {
  const { spawn } = await import("node:child_process");
  const { createPowerShellTool } = await import("@earendil-works/pi-coding-agent");
  const store = new NestedToolCallsStore(); store.beginRun(1);
  store.record(event("start", "r/live", "r", { toolName: "powershell", args: { command: "fixture compiler" } }));
  let child, ended = false, sawLive = false;
  // Only the executable is a fixture; SDK accumulation/throttling is real.
  const tool = createPowerShellTool(process.cwd(), { operations: { exec: (_command, cwd, { onData }) => new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["-e", "console.log('compile started'); process.stdin.resume(); process.stdin.on('end', () => console.log('compile finished'))"], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.once("error", reject); child.once("close", exitCode => { ended = true; resolve({ exitCode }); });
  }) } });
  const timer = setTimeout(() => child?.kill(), 10000);
  try {
    const result = await tool.execute("r/live", { command: "fixture compiler" }, undefined, partialResult => {
      store.record(event("update", "r/live", "r", { toolName: "powershell", partialResult }));
      if (!sawLive && store.getSnapshot("r").calls[0].output?.includes("compile started")) {
        assert.equal(ended, false); sawLive = true; child.stdin.end();
      }
    });
    assert.equal(sawLive, true);
    assert.match(result.content[0].text, /compile finished/);
  } finally { clearTimeout(timer); child?.kill(); store.reset(); }
});
