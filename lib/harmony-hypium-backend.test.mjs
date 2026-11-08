import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HypiumAutomationDriver } = await jiti.import("./harmony/hypium-backend.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");

function fakeBy() {
  const by = {};
  for (const name of ["id", "text", "type", "hint", "inWindow", "clickable", "scrollable", "enabled", "focused", "selected", "checked", "within", "isBefore", "isAfter"]) {
    by[name] = () => by;
  }
  by.type = type => { by.typeName = type; return by; };
  return by;
}

function fakeModule(driver, connect) {
  return {
    BY: { id: fakeBy, text: fakeBy, type: fakeBy, hint: fakeBy, inWindow: fakeBy, clickable: fakeBy, scrollable: fakeBy, enabled: fakeBy, focused: fakeBy, selected: fakeBy, checked: fakeBy },
    MatchPattern: { EQUALS: 0, CONTAINS: 1, STARTS_WITH: 2, ENDS_WITH: 3 },
    KeyCode: { APPSELECT: 1, ENTER: 2 },
    UiDriver: { connect: connect ?? (async () => driver) },
  };
}

test("Hypium connects once per device and reuses the persistent UiDriver session", async () => {
  let connections = 0;
  let privacyChecks = 0;
  let clicks = 0;
  const component = { async exist() { return true; }, async click() { clicks += 1; } };
  const driver = { findComponent() { return component; }, async findComponents() { return [component]; }, async disconnect() {} };
  const driverModule = fakeModule(driver, async () => { connections += 1; return driver; });
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => driverModule,
    preparePrivacy: () => { privacyChecks += 1; },
  });
  await Promise.all([
    hypium.semanticAction("phone-1", { action: "tap", selector: { id: "a" } }),
    hypium.semanticAction("phone-1", { action: "tap", selector: { id: "b" } }),
  ]);
  assert.equal(connections, 1);
  assert.equal(privacyChecks, 1);
  assert.equal(clicks, 2);
  assert.deepEqual(hypium.status(), [{ serial: "phone-1", state: "ready" }]);
  await hypium.reset();
});

test("Hypium semantic actions reject ambiguous targets and honor an explicit index", async () => {
  const clicked = [];
  const components = [0, 1].map((index) => ({
    async exist() { return true; },
    async click() { clicked.push(index); },
  }));
  const driver = {
    findComponent() { return components[0]; },
    async findComponents() { return components; },
    async disconnect() {},
  };
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(driver),
    preparePrivacy: () => {},
  });
  await assert.rejects(
    () => hypium.semanticAction("phone-1", { action: "tap", selector: { text: "Open" } }),
    (error) => error instanceof HarmonyError && error.code === "UI_TARGET_AMBIGUOUS",
  );
  await hypium.semanticAction("phone-1", { action: "tap", selector: { text: "Open", index: 1 } });
  assert.deepEqual(clicked, [1]);
  await hypium.reset();
});

test("connection failures enter a bounded cooldown and remain eligible for HDC fallback", async () => {
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(undefined, async () => { throw new Error("not supported"); }),
    preparePrivacy: () => {},
    now: () => Date.parse("2026-09-02T00:00:00.000Z"),
  });
  const first = await hypium.tryRun("phone-1", "tap", undefined, async () => undefined);
  const second = await hypium.tryRun("phone-1", "tap", undefined, async () => undefined);
  assert.deepEqual(first, { used: false });
  assert.deepEqual(second, { used: false });
  assert.equal(hypium.status()[0].state, "cooldown");
});

test("a connected RPC failure invalidates the session instead of duplicating the mutation", async () => {
  let disconnected = false;
  const driver = { async disconnect() { disconnected = true; } };
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(driver),
    preparePrivacy: () => {},
  });
  await assert.rejects(
    () => hypium.tryRun("phone-1", "tap", undefined, async () => { throw new Error("rpc lost"); }),
    (error) => error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_FAILED",
  );
  assert.equal(disconnected, true);
  assert.equal(hypium.status().some((entry) => entry.state === "ready"), false);
});

test("text input selects the editable focused field instead of its focused ancestors", async () => {
  let text = "", writes = 0;
  const field = { getType: async () => "textField", inputText: async value => { text = value; writes++; }, getText: async () => text };
  let components = [...["root", "Navigation", "Stack", "Web"].map(type => ({ getType: async () => type })), field];
  const driver = { findComponents: async by => {
    const types = await Promise.all(components.map(component => component.getType()));
    return components.filter((_component, index) => types[index] === by.typeName);
  }, disconnect: async () => {} };
  const hypium = new HypiumAutomationDriver({ hdcPath: "fake", importDriver: async () => fakeModule(driver), preparePrivacy: () => {} });
  assert.equal((await hypium.execute("phone", "input_text", ["Piora 中文"])).used, true);
  assert.equal(text, "Piora 中文"); assert.equal(writes, 1);
  components.push({ ...field, getType: async () => "TextInput" });
  await assert.rejects(() => hypium.execute("phone", "input_text", ["ambiguous"]), error => error.code === "UI_TARGET_AMBIGUOUS" && error.details.dispatchState === "not-sent");
  components = [{ getType: async () => "Web" }];
  await assert.rejects(() => hypium.execute("phone", "input_text", ["missing"]), error => error.code === "UI_TARGET_NOT_FOUND");
  assert.equal(writes, 1, "missing/ambiguous targets must never receive input");
  components = [{ ...field, getText: async () => "different" }];
  await assert.rejects(() => hypium.execute("phone", "input_text", ["expected"]), error => error.code === "SCENARIO_FAILED");
  await hypium.reset();
});
