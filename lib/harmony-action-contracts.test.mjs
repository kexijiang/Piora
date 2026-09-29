import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { actionCatalog, actionSchema, validateAction, scenarioStepSchema } = await jiti.import("./harmony/contracts/actions.ts");
const { runHarmonyScenario } = await jiti.import("./harmony/scenario-executor.ts");
const { dispatchHarmonyAction } = await jiti.import("./harmony/action-dispatcher.ts");

test("catalog discovery and discriminated runtime schemas cover the same actions", () => {
  const exposed = scenarioStepSchema.properties.action.anyOf.map(item => item.const);
  assert.deepEqual(exposed, Object.entries(actionCatalog).filter(([, value]) => value.scenario).map(([key]) => key));
  for (const action of exposed) assert.equal(actionSchema(action, "scenario").properties.action.const, action);
});
test("HTTP and scenarios reject invalid key, direction, duration and missing target before dispatch", () => {
  for (const mode of ["direct", "scenario"]) {
    assert.throws(() => validateAction({ action: "press_key", key: "unlock" }, mode), error => error.code === "INVALID_ARGUMENT");
    assert.throws(() => validateAction({ action: "tap" }, mode), error => error.code === "INVALID_ARGUMENT");
    validateAction({ action: "press_key", key: "home" }, mode);
  }
  assert.throws(() => validateAction({ action: "scroll_find", selector: { id: "a" }, direction: "left" }, "scenario"));
  assert.throws(() => validateAction({ action: "swipe", fromX: 0, fromY: 0, toX: 10, toY: 10, durationMs: "50" }, "direct"));
});

test("direct application mutations use the shared schema and preserve the selected device lease", async () => {
  const calls = [];
  const manager = Object.fromEntries(["stopApp", "clearAppData", "clearAppCache", "uninstallApp", "setAppEnabled", "installPackage", "uploadFile", "createDirectory", "deletePath", "renamePath", "chmodPath"].map(name => [name, async options => {
    calls.push({ name, options }); return { action: name, dispatchState: "sent", effect: "unknown", verification: "not-run" };
  }]));
  const shared = { serial: "device-1", leaseToken: "lease-1" };
  for (const [action, method] of [["stop_app", "stopApp"], ["clear_app_data", "clearAppData"], ["clear_app_cache", "clearAppCache"], ["uninstall_app", "uninstallApp"], ["enable_app", "setAppEnabled"], ["disable_app", "setAppEnabled"]]) {
    await dispatchHarmonyAction(manager, { action, ...shared, bundleName: "com.example.demo" });
    assert.equal(calls.at(-1).name, method);
    assert.deepEqual(calls.at(-1).options, { ...shared, signal: undefined, bundleName: "com.example.demo",
      ...(action === "enable_app" || action === "disable_app" ? { enabled: action === "enable_app" } : {}) });
  }
  await dispatchHarmonyAction(manager, { action: "install_app", ...shared, hapPath: "C:\\app.hap", replace: false });
  assert.equal(calls.at(-1).name, "installPackage");
  assert.equal(calls.at(-1).options.replace, false);
  assert.throws(() => validateAction({ action: "clear_app_data", ...shared, bundleName: "bad;name" }, "direct"));
  assert.throws(() => validateAction({ action: "install_app", ...shared, hapPath: "x", replace: "false" }, "direct"));
  await dispatchHarmonyAction(manager, { action: "upload_file", ...shared, kind: "shared", sourcePath: "C:\\upload.txt", path: "/data/local/tmp/upload.txt" });
  assert.equal(calls.at(-1).name, "uploadFile");
  assert.deepEqual(calls.at(-1).options.scope, { kind: "shared" });
  assert.throws(() => validateAction({ action: "upload_file", ...shared, kind: "shared", sourcePath: "x", path: "y", overwrite: "yes" }, "direct"));
  for (const [action, method] of [["create_directory", "createDirectory"], ["delete_path", "deletePath"], ["rename_path", "renamePath"]]) {
    await dispatchHarmonyAction(manager, { action, ...shared, kind: "shared", path: "/data/local/tmp/old", ...(action === "rename_path" ? { newPath: "/data/local/tmp/new" } : {}) });
    assert.equal(calls.at(-1).name, method);
  }
  await dispatchHarmonyAction(manager, { action: "chmod_path", ...shared, kind: "shared", path: "/data/local/tmp/old", mode: "640" });
  assert.equal(calls.at(-1).name, "chmodPath");
  assert.equal(calls.at(-1).options.mode, "640");
  assert.throws(() => validateAction({ action: "chmod_path", ...shared, kind: "shared", path: "/data/local/tmp/old", mode: "4755" }, "direct"));
});
const snapshot = { serial: "phone", generation: 1, revision: 1, capturedAt: new Date().toISOString(),
  nodes: [{ ref: "a", id: "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } }],
  quality: { treeStatus: "valid", scopeComplete: true, scope: "active-windows" } };
const context = backend => ({ serial: "phone", generation: 1, backend, signal: new AbortController().signal,
  capture: async () => snapshot, invalidateSnapshot() {} });
test("exact semantic input never falls back to a tap and unsafe text insertion", async () => {
  const calls = [];
  for (const step of [{ action: "input_text", text: "中文😀\nsecond", selector: { id: "a" } }, { action: "clear_text", selector: { id: "a" } }]) {
    const result = await runHarmonyScenario({ serial: "phone", leaseToken: "lease", steps: [step] }, context({
      kind: "fake", async tap() { calls.push("tap"); }, async inputText() { calls.push("text"); },
    }));
    assert.equal(result.steps[0].error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(result.steps[0].error.details.dispatchState, "not-sent");
  }
  assert.deepEqual(calls, []);
});
test("wait strategy reports the provider's real bounded-delay fallback", async () => {
  const result = await runHarmonyScenario({ serial: "phone", leaseToken: "lease", steps: [{ action: "wait_idle" }] }, context({
    kind: "fake", async waitForIdle() { return { strategy: "bounded_delay" }; },
  }));
  assert.equal(result.steps[0].strategy, "bounded_delay");
});
