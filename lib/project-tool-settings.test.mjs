import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const settings = await jiti.import("./project-tool-settings.ts");

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
    enabledCapabilityIds: ["tool:harmony_tap", "tool:read"],
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
