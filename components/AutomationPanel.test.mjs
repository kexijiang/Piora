import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("./AutomationPanel.tsx", import.meta.url), "utf8");
const messageView = fs.readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
const rightPanel = fs.readFileSync(new URL("./workspace/RightPanel.tsx", import.meta.url), "utf8");
const settingsNavigation = fs.readFileSync(new URL("../lib/settings-search.ts", import.meta.url), "utf8");

test("scheduled tasks expose creation, editing, run history, and destructive confirmation", () => {
  assert.match(panel, /\/api\/automations/);
  assert.match(panel, /notificationPolicy/);
  assert.match(panel, /runNow/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /detail\.runs/);
  assert.match(panel, /role="menu"/);
  assert.match(panel, /toggleStatus/);
  assert.match(panel, /fallbackName/);
  assert.match(panel, /automations\.deleted/);
  assert.match(panel, /automations\.newShort/);
  assert.match(panel, /aria-label=\{t\("automations\.new"\)\}/);
});

test("automation cards open the dedicated right panel and settings category", () => {
  assert.match(messageView, /piora-automation/);
  assert.match(messageView, /AutomationCard/);
  assert.match(messageView, /getAutomationToolCardDetails/);
  assert.match(messageView, /automationDetails/);
  assert.match(rightPanel, /AutomationPanel/);
  assert.match(rightPanel, /workspace-automation/);
  assert.match(settingsNavigation, /key: "automations"/);
});

test("settings keeps scheduled-task management embedded for editing and deletion", () => {
  const appShell = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const settingsAutomation = appShell.match(/automations:\s*\([\s\S]*?<AutomationPanel[\s\S]*?<\/AutomationPanel>|automations:\s*\([\s\S]*?<AutomationPanel[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(settingsAutomation, /<AutomationPanel/);
  assert.doesNotMatch(settingsAutomation, /setSettingsDialogOpen\(false\)/);
  assert.doesNotMatch(settingsAutomation, /openAutomation/);
  assert.match(panel, /method:\s*"PATCH"/);
  assert.match(panel, /method:\s*"DELETE"/);
});
