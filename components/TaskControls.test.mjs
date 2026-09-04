import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appShell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatInput = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const chatWindow = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const agentSession = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const settingsDialog = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("./SettingsDialog.module.css", import.meta.url), "utf8");
const archivedChats = readFileSync(new URL("./ArchivedChatsSettings.tsx", import.meta.url), "utf8");
const projectTools = readFileSync(new URL("./ProjectToolsConfig.tsx", import.meta.url), "utf8");

test("keeps conversation metadata and notifications out of the composer", () => {
  assert.doesNotMatch(chatInput, /TOOL_PRESETS|toolDropdown|soundEnabled|onAudioUnlock/);
  assert.match(settingsDialog, /key:\s*"conversation"/);
  assert.match(settingsDialog, /settings\.sessionTitlePromptTitle/);
  assert.match(settingsDialog, /writeSessionTitlePrompt/);
  assert.match(settingsDialog, /conversation\.onNotificationToggle/);
  assert.doesNotMatch(settingsDialog, /taskControls\.preset/);
  assert.doesNotMatch(appShell, /model\.permissions/);
  assert.doesNotMatch(appShell, /topbar-more-button/);
});

test("automatically optimizes an unnamed session title after a completed turn", () => {
  assert.match(appShell, /onlyIfUnnamed: true/);
  assert.match(appShell, /readSessionTitlePrompt\(window\.localStorage\)/);
  assert.match(appShell, /automaticTitleRequestsRef/);
  assert.match(appShell, /if \(selectedSession\?\.id === sessionId && !selectedSession\.name\?\.trim\(\)\)/);
  assert.match(agentSession, /onAgentEnd\?\.\(sid\)/);
});

test("opens settings as a viewport-wide page above the complete application shell", () => {
  assert.match(appShell, /\{settingsPage\}/);
  assert.match(appShell, /display: settingsDialogOpen \? "none" : "block"/);
  assert.match(appShell, /const effectiveRightPanelOpen = rightPanelOpen && !settingsDialogOpen/);
  assert.match(settingsDialog, /createPortal/);
  assert.match(settingsDialog, /aria-modal="true"/);
  assert.match(settingsDialog, /document\.body/);
  assert.match(settingsCss, /\.backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
  assert.match(settingsDialog, /sections\[activeEntry\.key\]/);
  assert.match(settingsDialog, /onActiveKeyChange\(entry\.key\)/);
  assert.match(appShell, /<ModelsConfig[\s\S]*?embedded/);
  assert.match(appShell, /<SkillsConfig embedded/);
  assert.match(appShell, /<PluginsConfig[\s\S]*?embedded/);
  assert.match(appShell, /<CompanionSettingsDialog[\s\S]*?embedded/);
  assert.doesNotMatch(appShell, /setSettingsDialogOpen\(false\);\s*setModelsConfigOpen/);
});

test("settings exposes a Codex-style back button on the left", () => {
  assert.match(settingsDialog, /className=\{styles\.backButton\}/);
  assert.match(settingsDialog, /name="arrowleft"/);
  assert.match(settingsDialog, /aria-label=\{t\("settings\.back"\)\}/);
  assert.match(settingsDialog, /className=\{styles\.backButton\}[\s\S]*?onClick=\{onClose\}/);
  assert.match(settingsDialog, /className=\{styles\.backLabel\}>\{t\("settings\.back"\)\}/);
  assert.match(settingsDialog, /styles\.desktopBackdrop/);
  assert.match(settingsCss, /\.desktopBackdrop\s*\{[^}]*top:\s*36px/);
  assert.match(settingsCss, /\.backButton\s*\{[^}]*min-height:\s*36px/);
});

test("settings owns archived chats instead of rendering them in project lists", () => {
  assert.match(settingsDialog, /key: "archived"/);
  assert.match(settingsDialog, /settings\.group\.history/);
  assert.match(settingsDialog, /name="archive"/);
  assert.match(appShell, /archived:\s*\([\s\S]*?<ArchivedChatsSettings/);
  assert.match(archivedChats, /Promise\.all\(\[/);
  assert.match(archivedChats, /flags\[session\.id\]\?\.archived/);
  assert.match(archivedChats, /archived: false/);
  assert.match(archivedChats, /method: "DELETE"/);
});

test("settings search stays inside the settings page and navigates to matching sections", () => {
  assert.match(settingsDialog, /useDeferredValue\(searchQuery\)/);
  assert.match(settingsDialog, /settings\.searchPlaceholder/);
  assert.match(settingsDialog, /filteredEntries\.map/);
  assert.match(settingsDialog, /setSearchQuery\(""\);\s*onActiveKeyChange\(entry\.key\)/);
  assert.match(settingsCss, /\.searchResults/);
});

test("anchors soft top-bar panels inside the top bar coordinate system", () => {
  assert.match(appShell, /position:\s*"absolute"/);
  assert.match(appShell, /left:\s*leftInViewport - topBarRect\.left/);
  assert.match(appShell, /className="soft-top-panel"/);
  assert.match(globalCss, /\.soft-top-panel-header/);
  assert.match(globalCss, /\.soft-menu-item:hover/);
});

test("keeps the conversation branch navigator out of the main top bar", () => {
  assert.doesNotMatch(appShell, /<BranchNavigator/);
  assert.doesNotMatch(appShell, /onBranchDataChange=/);
  assert.doesNotMatch(appShell, /"branches"\s*\|/);
});

test("exposes project-scoped capabilities without permission tiers", () => {
  assert.match(agentSession, /handleCapabilitySelection/);
  assert.match(agentSession, /type: "set_capabilities"/);
  assert.doesNotMatch(chatInput, /SessionToolsControl/);
  assert.match(projectTools, /\/api\/project-tools/);
  assert.match(settingsDialog, /key:\s*"tools"/);
  assert.doesNotMatch(agentSession, /toolPreset|permissionTier|PRESET_NONE/);
  assert.doesNotMatch(chatWindow, /onToolPresetChange|permissionPreset/);
});

test("keeps the file drawer toggle inside the shell and aligns both header states", () => {
  assert.match(appShell, /className=\{`topbar-control topbar-icon-button right-panel-toggle/);
  assert.match(appShell, /aria-controls="file-panel"/);
  assert.match(appShell, /<SessionHistoryDialog/);
  assert.match(appShell, /\{settingsPage\}/);
  assert.doesNotMatch(appShell, /\{appearanceOpen &&/);
  assert.doesNotMatch(appShell, /position:\s*"fixed", right:\s*8/);
  assert.doesNotMatch(globalCss, /\.right-panel-toggle\s*\{[^}]*top:/s);
});
