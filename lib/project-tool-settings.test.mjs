import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const settings = await jiti.import("./project-tool-settings.ts");

test("cold project inventory exposes default codemode without starting MCP and preserves opt-out", async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-codemode-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const started = join(root, "mcp-started.txt"), script = join(root, "mcp.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(started)}, "unexpected MCP connection");`);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [script] } } }));
  const { loadProjectToolsContext } = await jiti.import("./project-tools.ts");
  const initial = await loadProjectToolsContext(cwd, "normal");
  assert.deepEqual(initial.diagnostics, []);
  const codemode = initial.capabilities.items.find(item => item.id === "tool:codemode");
  assert.equal(codemode?.available, true);
  assert.equal(codemode.enabled, true);
  assert.deepEqual(codemode.activeToolNames, ["codemode"]);
  assert.equal(initial.tools.find(tool => tool.name === "codemode").defaultActive, true);
  assert.equal(existsSync(started), false);

  settings.writeProjectToolSettings(cwd, { preset: "custom", enabledCapabilityIds: ["tool:read"] }, 0);
  const disabled = await loadProjectToolsContext(cwd, "normal");
  assert.equal(disabled.capabilities.items.find(item => item.id === codemode.id).enabled, false);
  assert.deepEqual(disabled.capabilities.items.find(item => item.id === codemode.id).activeToolNames, []);
  settings.writeProjectToolSettings(cwd, { preset: "coding" }, 1);
  const restored = await loadProjectToolsContext(cwd, "normal");
  assert.equal(restored.capabilities.items.find(item => item.id === codemode.id).enabled, true);
  const device = await loadProjectToolsContext(cwd, "device-control");
  assert.equal(device.tools.some(tool => tool.name === "codemode"), false);
  assert.equal(existsSync(started), false);
});

test("gateway migration preserves unrelated tools and a disabled phone selection", () => {
  assert.deepEqual(settings.projectToolSelection({ preset: "custom", enabledCapabilityIds: ["tool:read"] }), {
    preset: "custom", enabledCapabilityIds: ["tool:read"],
  });
  assert.deepEqual(settings.projectToolSelection({ preset: "custom", enabledCapabilityIds: ["tool:harmony_tap", "tool:harmony_swipe"] }), {
    preset: "custom", enabledCapabilityIds: ["tool:harmony_control"],
  });
});

test("project tool settings are scoped by project and revisioned", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const path = join(root, "agent", "piora", "project-tools.json");

  assert.equal(settings.readProjectToolSettings(projectA, path), null);
  const saved = settings.writeProjectToolSettings(projectA, {
    preset: "custom",
    enabledCapabilityIds: ["tool:read", "tool:harmony_tap", "tool:read"],
  }, 0, path);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.enabledCapabilityIds, ["tool:harmony_tap", "tool:read"]);
  assert.equal(settings.readProjectToolSettings(projectB, path), null);
  assert.deepEqual(settings.projectToolSelection(settings.readProjectToolSettings(projectA, path)), {
    preset: "custom",
    enabledCapabilityIds: ["tool:harmony_control", "tool:read"],
  });
});

test("stale project tool writes fail without replacing the saved selection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-tools-conflict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(root, "agent", "piora", "project-tools.json");
  settings.writeProjectToolSettings(project, { preset: "coding" }, 0, path);

  assert.throws(
    () => settings.writeProjectToolSettings(project, { preset: "chat" }, 0, path),
    (error) => error instanceof settings.ProjectToolSettingsConflictError && error.currentRevision === 1,
  );
  assert.equal(settings.readProjectToolSettings(project, path).preset, "coding");
});

test("project settings preserve explicit native MCP resource grants while discovery is pending", async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-mcp-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  const record = settings.writeProjectToolSettings(root, { preset: "custom", enabledCapabilityIds: ["tool:codemode", "tool:mcp__local__echo", "mcp-resource:local", "unknown:rejected"] }, 0, path);
  assert.ok(settings.readProjectToolSettings(root, path).enabledCapabilityIds.includes("mcp-resource:local"));
  assert.equal(record.enabledCapabilityIds.includes("unknown:rejected"), false);
  const { buildProjectToolsCapabilities, buildProjectToolSelectionState } = await jiti.import("./project-tools.ts");
  const pending = buildProjectToolsCapabilities([], "normal", record);
  assert.deepEqual(pending.policy.enabledCapabilityIds, record.enabledCapabilityIds);
  assert.ok(pending.items.every(item => !item.available && item.activeToolNames.length === 0));
  const tools = [{ name: "codemode", description: "Fixture codemode" }, { name: "mcp__local__echo", description: "Fixture echo", exposure: "codemode" }, { name: "mcp__local__new", description: "New tool", exposure: "codemode" }];
  const resources = [{ id: "mcp-resource:local", label: "Resources", description: "Fixture resources", kind: "extension", available: true, toolNames: [] }];
  const live = buildProjectToolsCapabilities(tools, "normal", record, resources);
  assert.equal(live.items.find(item => item.id === "mcp-resource:local").enabled, true);
  assert.equal(live.items.find(item => item.id === "tool:mcp__local__new").enabled, false);
  const changed = buildProjectToolSelectionState({ tools, resources, record, profile: "normal" }, { preset: "custom", enabledCapabilityIds: ["tool:codemode", "mcp-resource:local"] }, 2);
  assert.deepEqual(changed.policy.enabledCapabilityIds, ["mcp-resource:local", "tool:codemode"]);
});

test("project inventory keeps loaded extension defaults and preserves explicit project opt-outs", async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-extension-defaults-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extensionPath = join(agentDir, "workflow.mjs");
  writeFileSync(extensionPath, `export default pi => {
    for (const [name, defaultActive] of [["fixture_workflow", true], ["fixture_opt_in", false]]) {
      pi.registerTool({ name, defaultActive, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
    }
  }`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensionPath] }));
  const { loadProjectToolsContext } = await jiti.import("./project-tools.ts");
  const initial = await loadProjectToolsContext(cwd, "normal");
  assert.deepEqual(initial.diagnostics, []);
  const workflow = initial.capabilities.items.find(item => item.id === "tool:fixture_workflow");
  assert.equal(workflow.enabled, true);
  assert.deepEqual(workflow.activeToolNames, ["fixture_workflow"]);
  assert.equal(initial.capabilities.items.find(item => item.id === "tool:fixture_opt_in").enabled, false);
  const selected = initial.capabilities.policy.enabledCapabilityIds.filter(id => id !== workflow.id);
  settings.writeProjectToolSettings(cwd, { preset: "custom", enabledCapabilityIds: selected }, 0);
  const disabled = await loadProjectToolsContext(cwd, "normal");
  assert.equal(disabled.capabilities.items.find(item => item.id === workflow.id).enabled, false);
  settings.writeProjectToolSettings(cwd, { preset: "custom", enabledCapabilityIds: [...selected, workflow.id] }, 1);
  const restored = await loadProjectToolsContext(cwd, "normal");
  assert.deepEqual(restored.capabilities.items.find(item => item.id === workflow.id).activeToolNames, ["fixture_workflow"]);
  assert.equal(restored.capabilities.items.find(item => item.id === "tool:fixture_opt_in").enabled, false);
});
