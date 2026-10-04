import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const settings = await jiti.import("./project-tool-settings.ts");

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
