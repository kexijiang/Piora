import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const card = fs.readFileSync(new URL("./SettingsPortabilityCard.tsx", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("settings portability stays inside Data & Diagnostics with an accessible file flow", () => {
  assert.match(settings, /<SettingsPortabilityCard\s*\/>/);
  assert.match(settings, /activeKey === "data"/);
  assert.match(card, /type="file"/);
  assert.match(card, /accept="\.json,application\/json"/);
  assert.match(card, /aria-labelledby="settings-import-preview-title"/);
  assert.match(card, /<table>/);
  assert.match(card, /role="alert"/);
  assert.match(card, /role="status"/);
});

test("import previews before applying and reopens settings after the controlled reload", () => {
  assert.match(card, /getPortableSettingsDiff/);
  assert.match(card, /applyPortableSettings/);
  assert.ok(card.indexOf("setPreview({") < card.indexOf("applyPortableSettings(window.localStorage"));
  assert.match(card, /SETTINGS_REOPEN_STORAGE_KEY/);
  assert.match(card, /SETTINGS_REOPEN_STORAGE_KEY, "data"/);
  assert.match(shell, /sessionStorage\.getItem\(SETTINGS_REOPEN_STORAGE_KEY\)/);
  assert.match(shell, /setSettingsDialogOpen\(true\)/);
});

test("import never clears arbitrary browser storage", () => {
  assert.doesNotMatch(card, /localStorage\.clear|sessionStorage\.clear/);
});
