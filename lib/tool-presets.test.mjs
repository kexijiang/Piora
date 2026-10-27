import assert from "node:assert/strict";
import test from "node:test";

const { resolveAgentToolsForRuntimeProfile } = await import("./tool-presets.ts");

test("normal mode preserves requested coding tools", () => {
  assert.deepEqual(resolveAgentToolsForRuntimeProfile("normal", ["read", "bash"]), ["read", "bash"]);
  assert.equal(resolveAgentToolsForRuntimeProfile("normal", undefined), undefined);
});

test("device-control clamps every enabled preset to Harmony and preserves explicit all-off", () => {
  const expected = ["harmony_control"];
  assert.deepEqual(resolveAgentToolsForRuntimeProfile("device-control", undefined), expected);
  assert.deepEqual(resolveAgentToolsForRuntimeProfile("device-control", ["bash", "read"]), expected);
  assert.deepEqual(resolveAgentToolsForRuntimeProfile("device-control", []), []);
});

test("the normal default includes every Pi built-in coding and read-only tool", async () => {
  const {createCodingTools,createReadOnlyTools}=await import("@earendil-works/pi-coding-agent");
  const {BUILTIN_AGENT_TOOLS}=await import("./tool-presets.ts");
  const {createJiti}=await import("jiti");
  const {buildSessionCapabilityCatalog,createSessionCapabilityPolicy}=await createJiti(import.meta.url).import("./session-capabilities.ts");
  const tools=[...createCodingTools(process.cwd()),...createReadOnlyTools(process.cwd())];
  const names=[...new Set(tools.map(tool=>tool.name))];
  for (const name of names) assert.ok(BUILTIN_AGENT_TOOLS.includes(name), "Pi built-in "+name+" is classified by the GUI");
  tools.push({name:"powershell",description:"Platform PowerShell"});
  names.push("powershell");
  const catalog=buildSessionCapabilityCatalog(tools,"normal");
  const defaults=createSessionCapabilityPolicy(undefined,catalog,"normal");
  for (const name of names) assert.ok(defaults.enabledCapabilityIds.includes("tool:"+name),name+" must remain available");
});
