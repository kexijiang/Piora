import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const control = readFileSync(new URL("./SessionToolsControl.tsx", import.meta.url), "utf8");
const input = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const projectTools = readFileSync(new URL("./ProjectToolsConfig.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
const rightPanel = readFileSync(new URL("./workspace/RightPanel.tsx", import.meta.url), "utf8");

test("tool selection lives in project settings instead of the composer", () => {
  assert.doesNotMatch(input, /<SessionToolsControl/);
  assert.match(settings, /key: "tools"/);
  assert.match(projectTools, /\/api\/project-tools/);
  assert.match(projectTools, /projectTools\.disableHarmony/);
  assert.match(projectTools, /kind === "device"/);
  assert.match(projectTools, /preset: "custom"/);
  assert.match(projectTools, /preset: "coding"/);
  assert.match(projectTools, /role="switch"/);
});

test("the dormant session control remains reusable but is no longer mounted", () => {
  assert.match(control, /aria-haspopup="dialog"/);
  assert.match(control, /role="switch"/);
  assert.match(control, /data-placement=\{placement\.side\}/);
  assert.match(control, /preset: "custom"/);
  assert.match(control, /sessionTools\.defaultOn/);
  assert.match(control, /sessionTools\.useCodingDefaults/);
  assert.match(control, /preset: "coding"/);
  assert.doesNotMatch(control, /const PRESETS|selectPreset/);
});

test("browser and Harmony panels disclose model access separately from panel access", () => {
  assert.match(rightPanel, /capabilityAccess\("browser"\)/);
  assert.match(rightPanel, /capabilityAccess\("device"\)/);
  assert.match(rightPanel, /sessionTools\.panelAccessOff/);
});
