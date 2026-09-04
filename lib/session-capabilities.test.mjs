import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const capabilities = await jiti.import("./session-capabilities.ts");

const tools = (names) => names.map((name) => ({ name, description: `${name} description` }));

test("new normal sessions start with the compact coding tool set", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools([
    "read",
    "bash",
    "browser",
    "harmony_observe_screen",
    "piora_request_user_input",
    "piora_automation",
    "piora_room",
    "piora_goal",
  ]), "normal");
  const policy = capabilities.createSessionCapabilityPolicy(undefined, catalog, "normal");
  const active = capabilities.resolveSessionCapabilityToolNames(
    catalog,
    policy,
    catalog.flatMap((item) => item.toolNames),
  );

  assert.equal(policy.preset, "coding");
  assert.deepEqual(policy.enabledCapabilityIds, [
    "tool:bash",
    "tool:browser",
    "tool:read",
  ]);
  assert.deepEqual(active, [
    "bash",
    "browser",
    "read",
  ]);
  assert.equal(active.includes("piora_goal"), false);
});

test("chat-only has no ordinary or extension tools", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools([
    "read",
    "browser",
    "piora_goal",
    "piora_plan",
  ]), "normal");
  const policy = capabilities.createSessionCapabilityPolicy({ preset: "chat" }, catalog, "normal");
  assert.deepEqual(capabilities.resolveSessionCapabilityToolNames(
    catalog,
    policy,
    ["read", "browser", "piora_goal", "piora_plan"],
  ), []);
});

test("legacy sessions without capability metadata migrate to the compact coding tool set", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools([
    "read",
    "browser",
    "harmony_observe_screen",
    "piora_request_user_input",
    "piora_automation",
    "piora_room",
  ]), "normal");
  const policy = capabilities.restoreSessionCapabilityPolicy([], catalog);

  assert.equal(policy.revision, 0);
  assert.equal(policy.preset, "coding");
  assert.deepEqual(policy.enabledCapabilityIds, [
    "tool:browser",
    "tool:read",
  ]);
});

test("a tool can be disabled and then enabled again without leaving the catalog", () => {
  const initial = capabilities.createDefaultSessionCapabilitiesState("normal");
  const browser = initial.items.find((item) => item.toolNames.includes("browser"));
  assert.ok(browser?.enabled);

  const disabled = capabilities.applySessionCapabilitySelectionToState(initial, {
    preset: "custom",
    enabledCapabilityIds: initial.policy.enabledCapabilityIds.filter((id) => id !== browser.id),
  });
  assert.equal(disabled.items.find((item) => item.id === browser.id)?.enabled, false);
  assert.ok(disabled.items.find((item) => item.id === browser.id));

  const reenabled = capabilities.applySessionCapabilitySelectionToState(disabled, {
    preset: "custom",
    enabledCapabilityIds: [...disabled.policy.enabledCapabilityIds, browser.id],
  });
  assert.equal(reenabled.items.find((item) => item.id === browser.id)?.enabled, true);
  assert.equal(reenabled.items.find((item) => item.id === browser.id)?.activeToolNames[0], "browser");
});

test("the latest persisted session policy wins", () => {
  const entries = [
    {
      type: "custom",
      customType: capabilities.SESSION_CAPABILITY_ENTRY_TYPE,
      data: {
        version: 1,
        revision: 1,
        preset: "coding",
        enabledCapabilityIds: ["workspace"],
        knownCapabilityIds: ["workspace", "browser"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: capabilities.SESSION_CAPABILITY_ENTRY_TYPE,
      data: {
        version: 1,
        revision: 2,
        preset: "research",
        enabledCapabilityIds: ["browser"],
        knownCapabilityIds: ["workspace", "browser"],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    },
  ];

  assert.deepEqual(capabilities.readLatestSessionCapabilityPolicy(entries), {
    ...entries[1].data,
    knownCapabilityIds: ["browser", "workspace"],
  });
});

test("the earlier grouped policy format migrates to individual tool switches", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools([
    "read",
    "bash",
    "browser",
    "harmony_tap",
  ]), "normal");
  const policy = capabilities.restoreSessionCapabilityPolicy([{
    type: "custom",
    customType: capabilities.SESSION_CAPABILITY_ENTRY_TYPE,
    data: {
      version: 1,
      revision: 4,
      preset: "custom",
      enabledCapabilityIds: ["workspace", "browser"],
      knownCapabilityIds: ["workspace", "browser", "harmony"],
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
  }], catalog);

  assert.equal(policy.revision, 4);
  assert.deepEqual(policy.enabledCapabilityIds, ["tool:bash", "tool:browser", "tool:read"]);
});

test("third-party extension tools remain individually selectable", () => {
  const sourceInfo = {
    path: "C:\\extensions\\weather.ts",
    source: "weather-kit",
    scope: "user",
    origin: "package",
  };
  const catalog = capabilities.buildSessionCapabilityCatalog([
    { name: "weather_now", description: "Current weather", sourceInfo },
    { name: "weather_forecast", description: "Forecast", sourceInfo },
  ], "normal");
  const extensions = catalog.filter((item) => item.kind === "extension");
  assert.equal(extensions.length, 2);
  assert.deepEqual(extensions.map((item) => item.toolNames[0]), ["weather_forecast", "weather_now"]);
  assert.deepEqual(extensions.map((item) => item.id), ["tool:weather_forecast", "tool:weather_now"]);
});

test("device-control keeps its registered tools visible but enables only the allowed Harmony tools", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools([
    "read",
    "harmony_observe_screen",
    "harmony_tap",
  ]), "device-control");
  const policy = capabilities.createSessionCapabilityPolicy(undefined, catalog, "device-control");
  const workspace = catalog.find((item) => item.id === "tool:read");
  const harmony = catalog.filter((item) => item.kind === "device");

  assert.equal(workspace.available, false);
  assert.equal(workspace.unavailableReason, "profile_restricted");
  assert.equal(harmony.every((item) => item.available), true);
  assert.equal(policy.preset, "custom");
  assert.deepEqual(policy.enabledCapabilityIds, ["tool:harmony_observe_screen", "tool:harmony_tap"]);
});

test("a runtime ceiling cannot be widened by a session capability", () => {
  const catalog = capabilities.buildSessionCapabilityCatalog(tools(["read", "bash", "browser"]), "normal");
  const policy = capabilities.createSessionCapabilityPolicy({ preset: "coding" }, catalog, "normal");
  const active = capabilities.resolveSessionCapabilityToolNames(
    catalog,
    policy,
    ["read", "bash", "browser"],
    new Set(["read"]),
  );

  assert.deepEqual(active, ["read"]);
});
