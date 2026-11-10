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
const { betaFeatureRevision, subscribeBetaFeatureChanges } = await jiti.import("./beta-feature-events.ts");
const { loadedBetaFeatureSignature } = await jiti.import("./beta-feature-types.ts");

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
  const candidates = ["piora:intelligent-ui", "piora:mini-app"].map(id => result.candidates.find(item => item.id === id));
  for (const candidate of candidates) {
    assert.ok(candidate);
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.configurable, false);
    assert.equal(result.enabledPaths.includes(candidate.path), false);
    assert.throws(() => setExtensionEnabled(candidate.id, true, join(root, "extensions.json")), /Beta Features/);
  }
  writeBetaFeatures({ intelligentUi: true }, agentDir);
  result = await plan();
  for (const candidate of candidates) assert.ok(result.enabledPaths.includes(candidate.path));
  writeBetaFeatures({ intelligentUi: false }, agentDir);
  result = await plan();
  for (const candidate of candidates) assert.equal(result.enabledPaths.includes(candidate.path), false);
  const device = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "device-control" });
  for (const candidate of candidates) assert.equal(device.candidates.some(item => item.id === candidate.id), false);
  assert.equal(loadedBetaFeatureSignature([{ name: "piora_render_mini_app" }]), "intelligentUi:true");
  assert.equal(loadedBetaFeatureSignature([]), "intelligentUi:false");
});

test("feature notifications observe persisted values, survive rapid off/on, and remain scoped to their root", t => {
  const root = mkdtempSync(join(tmpdir(), "piora-beta-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second"), changes = [];
  const unsubscribe = subscribeBetaFeatureChanges(first, features => {
    assert.deepEqual(readBetaFeatures(first), features, "the write precedes notification");
    assert.ok(Object.isFrozen(features));
    changes.push({ enabled: features.intelligentUi, revision: betaFeatureRevision(first) });
  });
  t.after(unsubscribe);
  writeBetaFeatures({ intelligentUi: false }, first);
  assert.equal(betaFeatureRevision(first), 0);
  writeBetaFeatures({ intelligentUi: true }, first);
  writeBetaFeatures({ intelligentUi: true }, first);
  writeBetaFeatures({ intelligentUi: false }, first);
  writeBetaFeatures({ intelligentUi: true }, first);
  writeBetaFeatures({ intelligentUi: true }, second);
  assert.deepEqual(changes, [{ enabled: true, revision: 1 }, { enabled: false, revision: 2 }, { enabled: true, revision: 3 }]);
  assert.equal(betaFeatureRevision(second), 1);
  unsubscribe();
  writeBetaFeatures({ intelligentUi: false }, first);
  assert.equal(changes.length, 3);
});
