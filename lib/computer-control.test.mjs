import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ComputerControlRuntime, compactComputerContent } = await jiti.import("./computer-control.ts");
const { default: register } = await jiti.import("../extensions/piora-computer.ts");
const { estimateToolDefinitionPromptTokens } = await jiti.import("./tool-definition-budget.ts");

test("computer schemas use a single compact model entry", () => {
  const tools = []; register({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 1); assert.ok(estimateToolDefinitionPromptTokens(tools) < 600);
});
test("desktop output is bounded and cannot forward arbitrary MCP resource blocks", () => {
  const content = compactComputerContent([{ type: "text", text: "x".repeat(20000) }, { type: "resource", resource: { uri: "file:///private" } }, { type: "image", data: "abc", mimeType: "image/png" }, { type: "image", data: "def", mimeType: "image/png" }]);
  assert.equal(content.length, 2); assert.ok(content[0].text.length < 12100);
});
test("one owner controls the desktop; emergency stop persists until manually resumed", async () => {
  const runtime = new ComputerControlRuntime();
  runtime.claim("one"); assert.throws(() => runtime.claim("two"), /Another task/);
  await runtime.release("two"); assert.throws(() => runtime.claim("two"), /Another task/);
  await runtime.stop(); assert.equal(runtime.state().stopped, true);
  await assert.rejects(() => runtime.connect(), /stopped/);
  runtime.resume(); assert.equal(runtime.state().stopped, false);
});

test("desktop calls forward exact operation arguments and propagate backend failure", async () => {
  const runtime = new ComputerControlRuntime();
  const calls = [];
  runtime.client = { callTool: async (input) => { calls.push(input); return { isError: true, content: [{ type: "text", text: "target missing" }] }; } };
  runtime.tools = [{ name: "Click", inputSchema: { type: "object" } }];
  const result = await runtime.call("one", "Click", { loc: [10, 20] });
  assert.deepEqual(calls, [{ name: "Click", arguments: { loc: [10, 20] } }]);
  assert.equal(result.isError, true);
  await runtime.release("one");
});

test("failed desktop actions disconnect and are never automatically replayed", async () => {
  const runtime = new ComputerControlRuntime(); let calls = 0;
  runtime.client = { callTool: async () => { calls++; throw new Error("timeout"); } };
  runtime.tools = [{ name: "Click", inputSchema: { type: "object" } }];
  await assert.rejects(() => runtime.call("one", "Click", {}), /timeout/);
  assert.equal(calls, 1); assert.equal(runtime.state().connected, false);
  runtime.claim("two");
});
