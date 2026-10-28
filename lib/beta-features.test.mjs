import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url);
const { readBetaFeatures, writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { resolveExtensionLoadPlan, setExtensionEnabled } = await jiti.import("./extension-config.ts");

test("beta preferences fail closed, persist explicit opt-in and reject unknown or malformed settings", t => {
  const root = mkdtempSync(join(tmpdir(), "piora-beta-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readBetaFeatures(root), { intelligentUi: false });
  writeBetaFeatures({ intelligentUi: true }, root);
  assert.deepEqual(readBetaFeatures(root), { intelligentUi: true });
  for (const input of [null, [], {}, { intelligentUi: "true" }, { intelligentUi: true, unknown: true }]) {
    assert.throws(() => writeBetaFeatures(input, root), /boolean/);
  }
  assert.deepEqual(readBetaFeatures(root), { intelligentUi: true });
  writeBetaFeatures({ intelligentUi: false }, root);
  assert.deepEqual(readBetaFeatures(root), { intelligentUi: false });
  for (const text of ["broken", '{"version":2,"intelligentUi":true}', '{"version":1,"intelligentUi":"true"}']) {
    writeFileSync(join(root, "piora", "beta-features.json"), text);
    assert.deepEqual(readBetaFeatures(root), { intelligentUi: false });
  }
});

test("experimental module is excluded before loading; Beta Features is its only switch", async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-beta-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
  mkdirSync(agentDir); mkdirSync(cwd);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const plan = () => resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal", preferences: { version: 1, disabled: [] } });
  let result = await plan();
  const candidate = result.candidates.find(item => item.id === "piora:intelligent-ui");
  assert.ok(candidate);
  assert.equal(candidate.enabled, false);
  assert.equal(candidate.configurable, false);
  assert.equal(result.enabledPaths.includes(candidate.path), false);
  assert.throws(() => setExtensionEnabled(candidate.id, true, join(root, "extensions.json")), /Beta Features/);
  writeBetaFeatures({ intelligentUi: true }, agentDir);
  result = await plan();
  assert.ok(result.enabledPaths.includes(candidate.path));
  writeBetaFeatures({ intelligentUi: false }, agentDir);
  assert.equal((await plan()).enabledPaths.includes(candidate.path), false);
  const device = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "device-control" });
  assert.equal(device.candidates.some(item => item.id === candidate.id), false);
});
