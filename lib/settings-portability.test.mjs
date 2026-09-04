import assert from "node:assert/strict";
import test from "node:test";
const { createJiti } = await import("jiti");
const {
  SettingsPortabilityError,
  applyPortableSettings,
  createPortableSettingsBundle,
  getPortableSettingsDiff,
  parsePortableSettings,
  readPortableSettingsPreferences,
  serializePortableSettings,
} = await createJiti(import.meta.url).import("./settings-portability.ts");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function sampleBundle() {
  return {
    product: "piora",
    schemaVersion: 1,
    exportedAt: "2026-08-09T00:00:00.000Z",
    excluded: [],
    preferences: {
      theme: "dark",
      background: { schemaVersion: 1, source: "none", presetId: null, overlay: 58, blur: 0 },
      font: { schemaVersion: 1, family: "inter", size: 16, weight: 700 },
      locale: "zh-CN",
      completionNotifications: true,
      globalShortcut: false,
    },
  };
}

test("exports only versioned non-sensitive preferences and excludes custom image bytes", () => {
  const storage = new MemoryStorage();
  storage.setItem("pi-theme:v1", JSON.stringify({ theme: "forest" }));
  storage.setItem("pi-background:v1", JSON.stringify({ schemaVersion: 1, source: "custom", presetId: null, overlay: 42, blur: 3 }));
  storage.setItem("pi-background:custom-data-url:v1", "data:image/png;base64,SECRET_IMAGE_BYTES");
  storage.setItem("provider-api-key", "SECRET_API_KEY");
  const bundle = createPortableSettingsBundle(storage, "zh-CN", new Date("2026-08-09T00:00:00.000Z"));
  const serialized = serializePortableSettings(bundle);

  assert.equal(bundle.preferences.theme, "forest");
  assert.equal(bundle.preferences.background, undefined);
  assert.deepEqual(bundle.excluded, ["customBackgroundImage"]);
  assert.doesNotMatch(serialized, /SECRET|api.?key|oauth|session|project/i);
  assert.equal(parsePortableSettings(serialized).preferences.locale, "zh-CN");
});

test("rejects unknown fields, wrong products, unsupported versions, and invalid values", () => {
  const cases = [
    [{ ...sampleBundle(), apiKey: "secret" }, "unknown"],
    [{ ...sampleBundle(), product: "codex" }, "product"],
    [{ ...sampleBundle(), schemaVersion: 2 }, "version"],
    [{ ...sampleBundle(), preferences: { ...sampleBundle().preferences, theme: "unknown" } }, "invalid"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => parsePortableSettings(JSON.stringify(value)),
      (error) => error instanceof SettingsPortabilityError && error.code === code,
    );
  }
  assert.throws(() => parsePortableSettings("{"), (error) => error.code === "malformed");
  assert.throws(() => parsePortableSettings(" ".repeat(65 * 1024)), (error) => error.code === "oversized");
});

test("imports legacy font settings and preserves weight through export and import", () => {
  const legacy = sampleBundle();
  delete legacy.preferences.font.weight;
  assert.equal(parsePortableSettings(JSON.stringify(legacy)).preferences.font.weight, 400);
  for (const weight of [400, 500, 700]) {
    const bundle = sampleBundle();
    bundle.preferences.font.weight = weight;
    assert.equal(parsePortableSettings(serializePortableSettings(bundle)).preferences.font.weight, weight);
  }
  const invalid = sampleBundle();
  invalid.preferences.font.weight = 900;
  assert.throws(() => parsePortableSettings(JSON.stringify(invalid)), (error) => error.code === "invalid");
});

test("previews exact changes and applies only the storage allow-list", () => {
  const storage = new MemoryStorage();
  storage.setItem("pi-theme:v1", JSON.stringify({ theme: "light" }));
  storage.setItem("do-not-touch", "preserved");
  const current = readPortableSettingsPreferences(storage, "en").preferences;
  const incoming = sampleBundle();
  const diff = getPortableSettingsDiff(current, incoming.preferences);
  assert.deepEqual(diff.map((item) => item.key), ["theme", "background", "font", "locale", "completionNotifications"]);

  const applied = applyPortableSettings(storage, incoming);
  assert.deepEqual(applied, ["theme", "background", "font", "locale", "completionNotifications", "globalShortcut"]);
  assert.equal(storage.getItem("do-not-touch"), "preserved");
  assert.equal(JSON.parse(storage.getItem("pi-theme:v1")).theme, "dark");
  assert.equal(storage.getItem("pi-locale"), "zh-CN");
  assert.equal(JSON.parse(storage.getItem("pi-font-preference:v1")).weight, 700);
  assert.equal(storage.getItem("pi-completion-notifications-enabled"), "true");
});
