// Read-only protocol smoke test. Does not inspect or manipulate desktop contents.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { getComputerControl, WINDOWS_COMPUTER_TOOLS, WINDOWS_MCP_VERSION } = await jiti.import("../lib/computer-control.ts");
const runtime = getComputerControl();
try {
  runtime.resume();
  const inventory = await runtime.help();
  assert.deepEqual(inventory.operations.map((tool) => tool.name).sort(), [...WINDOWS_COMPUTER_TOOLS].sort());
  const snapshot = await runtime.help("Snapshot");
  assert.equal(snapshot.inputSchema.type, "object");
  console.log(JSON.stringify({ connected: true, version: WINDOWS_MCP_VERSION, operations: inventory.operations.length, schema: "Snapshot", desktopActions: 0 }));
} finally {
  await runtime.stop();
  assert.equal(runtime.state().connected, false);
  assert.equal(runtime.state().stopped, true);
}
