import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [sidebar, sidebarNavigation, settings, settingsCss, rightPanel, workspaceCss, shell, desktopMain, preload, commands] = await Promise.all([
  readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/SidebarNavigation.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SettingsDialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SettingsDialog.module.css", import.meta.url), "utf8"),
  readFile(new URL("./workspace/RightPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./workspace/WorkspacePanel.module.css", import.meta.url), "utf8"),
  readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/preload.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/commands.ts", import.meta.url), "utf8"),
]);

test("the sidebar keeps task state in Projects without a duplicate Activity feed", () => {
  assert.doesNotMatch(sidebar, /SidebarActivity|sidebar\.activity/);
  assert.doesNotMatch(sidebarNavigation, /onOpenPlugins|onOpenSkills/);
  assert.match(sidebarNavigation, /onOpenSettings/);
});

test("settings expose every available feature directly in grouped navigation", () => {
  assert.match(settings, /labelKey: "settings\.general"/);
  assert.match(settings, /labelKey: "settings\.conversation"/);
  assert.match(settings, /labelKey: "settings\.extensions"/);
  assert.match(settings, /settings\.group\.personal/);
  assert.match(settings, /settings\.group\.capabilities/);
  assert.match(settings, /settings\.group\.history/);
  assert.match(settings, /sections\[entry\.key\] !== undefined/);
  assert.doesNotMatch(settings, /getSettingsParentKey|styles\.subnavigation/);
  assert.match(settingsCss, /grid-template-columns:\s*258px minmax\(0, 1fr\)/);
  assert.match(settingsCss, /\.contentCanvas/);
  assert.match(settingsCss, /@media \(max-width: 760px\)/);
  assert.match(settingsCss, /@media \(max-width: 520px\)/);
});

test("desktop chrome has one Settings entry and no duplicate Features menu", () => {
  assert.equal((desktopMain.match(/sendMenuAction\("settings"\)/g) ?? []).length, 1);
  assert.doesNotMatch(desktopMain, /app-menu-features|模型设置|技能管理|插件管理|宠物设置/);
  assert.doesNotMatch(shell, /id: "features"/);
  assert.doesNotMatch(preload, /"features"/);
});

test("file lookup stays in Files and the standalone Search tab is removed", () => {
  assert.doesNotMatch(rightPanel, /SearchPanel|workspace-search|"search"/);
  assert.match(shell, /navigate\.searchFiles[\s\S]*?setRightPanelTab\("files"\)/);
  assert.doesNotMatch(commands, /command\("panel\.search"/);
});

test("the command input uses a compact low-contrast focus treatment", () => {
  assert.match(workspaceCss, /\.commandInputWrap > input \{[^}]*height: 30px;/);
  assert.match(workspaceCss, /\.commandInputWrap > input:focus-visible \{[^}]*var\(--text-muted\) 24%[^}]*var\(--text-muted\) 5%/);
  assert.doesNotMatch(workspaceCss, /\.searchControls > input,\.commandInputWrap > input/);
});

test("workspace actions share compact subtle button styling", () => {
  assert.match(workspaceCss, /\.iconAction \{[^}]*width: 28px;/);
  assert.match(workspaceCss, /\.iconAction:focus-visible \{[^}]*outline: 0/);
  assert.match(workspaceCss, /\.primaryAction \{/);
  assert.match(workspaceCss, /\.reviewToolbar button[^}]*min-height: var\(--control-height-compact\);/);
  assert.match(workspaceCss, /color-mix\(in srgb, var\(--accent\) 36%/);
});
