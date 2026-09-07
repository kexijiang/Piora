import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./extension-config.ts");
const firstParty = await jiti.import("./first-party-extensions.ts");

function fakeExtension(path, sourceInfo = { path, source: "cli", scope: "temporary", origin: "top-level" }) {
  return {
    path,
    resolvedPath: path,
    sourceInfo,
    handlers: new Map(),
    tools: new Map([["sample_tool", {}]]),
    messageRenderers: new Map(),
    commands: new Map([["sample", {}]]),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

test("extension preferences persist an idempotent disabled set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-extension-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "nested", "extensions.json");

  config.setExtensionEnabled("piora:plan", false, path);
  config.setExtensionEnabled("piora:plan", false, path);
  assert.deepEqual(config.readExtensionPreferences(path).disabled, ["piora:computer", "piora:goal", "piora:plan"]);
  config.setExtensionEnabled("piora:plan", true, path);
  assert.deepEqual(config.readExtensionPreferences(path).disabled, ["piora:computer", "piora:goal"]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
});

test("goal and plan workflow extensions are disabled until the user enables them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-optional-workflow-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "extensions.json");

  const defaults = config.readExtensionPreferences(path);
  assert.deepEqual(defaults.disabled, ["piora:computer", "piora:goal", "piora:plan"]);
  assert.equal(config.isExtensionIdEnabled("piora:goal", defaults), false);
  assert.equal(config.isExtensionIdEnabled("piora:plan", defaults), false);

  const enabled = config.setExtensionEnabled("piora:goal", true, path);
  assert.equal(config.isExtensionIdEnabled("piora:goal", enabled), true);
  assert.equal(config.isExtensionIdEnabled("piora:plan", enabled), false);
});

test("core browser and Harmony capabilities cannot be disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-core-extension-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "extensions.json");
  const preferences = { version: 1, disabled: ["piora:browser", "piora:harmony"] };

  assert.equal(config.isExtensionIdEnabled("piora:browser", preferences), true);
  assert.equal(config.isExtensionIdEnabled("piora:harmony", preferences), true);
  assert.throws(
    () => config.setExtensionEnabled("piora:browser", false, path),
    /core capability extensions cannot be disabled/,
  );
});

test("packaged first-party resources use the explicit runtime archive root", () => {
  const runtimeRoot = join(tmpdir(), "piora-packaged-web", "runtime.asar");
  assert.equal(
    firstParty.firstPartyRuntimeRoot({ PIORA_WEB_RUNTIME_ROOT: runtimeRoot }),
    runtimeRoot,
  );
});

test("normal load plans keep core capabilities enabled and locked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-required-extension-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const plan = await config.resolveExtensionLoadPlan({
    cwd,
    agentDir,
    settingsManager,
    profile: "normal",
    preferences: { version: 1, disabled: ["piora:browser", "piora:harmony"] },
  });

  for (const id of ["piora:browser", "piora:harmony"]) {
    const candidate = plan.candidates.find((item) => item.id === id);
    assert.ok(candidate);
    assert.equal(candidate.enabled, true);
    assert.equal(candidate.required, true);
    assert.equal(candidate.configurable, false);
    assert.equal(plan.enabledPaths.includes(candidate.path), true);
  }
});

test("inventory and runtime filtering share the same stable extension identity", () => {
  const planPath = firstParty.firstPartyExtensionPath(
    firstParty.FIRST_PARTY_EXTENSIONS.find(({ id }) => id === "piora:plan"),
  );
  const extension = fakeExtension(planPath);
  const preferences = { version: 1, disabled: ["piora:plan"] };
  const result = { extensions: [extension], errors: [], runtime: {} };

  assert.equal(config.extensionId(extension), "piora:plan");
  assert.equal(config.buildExtensionInventory([extension], preferences)[0].enabled, false);
  assert.deepEqual(config.filterConfiguredExtensions(result, preferences).extensions, []);
});

test("a user extension cannot impersonate a first-party extension by filename", () => {
  const path = join(tmpdir(), "untrusted", "piora-plan.ts");
  const extension = fakeExtension(path, {
    path,
    source: path,
    scope: "user",
    origin: "top-level",
  });
  assert.notEqual(config.extensionId(extension), "piora:plan");
  assert.match(config.extensionId(extension), /^path:user:/);
});

test("the pre-load plan excludes disabled extension modules before Pi executes them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-extension-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const disabledPath = join(extensionsDir, "disabled.ts");
  await writeFile(disabledPath, "throw new Error('disabled extension executed');\nexport default function () {}\n", "utf8");

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const initial = await config.resolveExtensionLoadPlan({
    cwd,
    agentDir,
    settingsManager,
    profile: "normal",
    preferences: { version: 1, disabled: [] },
  });
  const candidate = initial.candidates.find(({ path }) => path === disabledPath);
  assert.ok(candidate);

  const filtered = await config.resolveExtensionLoadPlan({
    cwd,
    agentDir,
    settingsManager,
    profile: "normal",
    preferences: { version: 1, disabled: [candidate.id] },
  });
  assert.ok(filtered.candidates.some(({ id, enabled }) => id === candidate.id && !enabled));
  assert.equal(filtered.enabledPaths.includes(disabledPath), false);
});
