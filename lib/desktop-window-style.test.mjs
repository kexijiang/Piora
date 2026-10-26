import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(
  new URL("../desktop/src/main.ts", import.meta.url),
  "utf8",
);
const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const appShellSource = readFileSync(
  new URL("../components/AppShell.tsx", import.meta.url),
  "utf8",
);
const mermaidBlockSource = readFileSync(
  new URL("../components/MermaidBlock.tsx", import.meta.url),
  "utf8",
);

test("desktop shell integrates content with native window controls", () => {
  assert.match(mainSource, /titleBarStyle:\s*"hidden"/);
  assert.match(mainSource, /titleBarOverlay:\s*{/);
  assert.match(mainSource, /color:\s*"#00000000"/);
  assert.match(mainSource, /symbolColor:\s*"#737373"/);
  assert.match(mainSource, /height:\s*DESKTOP_TITLE_BAR_HEIGHT/);
  assert.match(mainSource, /autoHideMenuBar:\s*true/);
  assert.match(mainSource, /function createCompanionWindow[\s\S]*frame:\s*false[\s\S]*transparent:\s*true/);
  assert.match(mainSource, /PIORA_COMPANION_UI_TEST_USER_DATA/);
  assert.match(mainSource, /app\.setPath\("userData",\s*resolve\(requestedCompanionUiTestUserData\)\)/);
});

test("hidden menu keeps the installed application menu and accelerators", () => {
  assert.match(mainSource, /Menu\.setApplicationMenu\(applicationMenu\)/);
  assert.match(mainSource, /accelerator:\s*"CmdOrCtrl\+/);
  assert.match(mainSource, /registerApplicationMenuPopupHandler\(\)/);
  assert.match(appShellSource, /window\.piDesktop\?\.openMenu/);
});

test("desktop menus mirror the compact File, Edit, View, and Help structure", () => {
  assert.equal((mainSource.match(/sendMenuAction\("settings"\)/g) ?? []).length, 1);
  assert.doesNotMatch(mainSource, /app-menu-tools|sendMenuAction\("(?:models|skills|plugins|appearance|language|companion-settings)"\)/);
  assert.doesNotMatch(mainSource, /id:\s*"app-menu-window"/);
  assert.match(mainSource, /id:\s*"app-menu-file"[\s\S]*?role:\s*"close"[\s\S]*?role:\s*"quit"/);
  assert.match(mainSource, /id:\s*"app-menu-edit"/);
  const viewMenu = mainSource.slice(
    mainSource.indexOf('id: "app-menu-view"'),
    mainSource.indexOf('id: "app-menu-help"'),
  );
  assert.match(viewMenu, /toggle-sidebar/);
  assert.match(viewMenu, /toggle-files/);
  assert.match(viewMenu, /open-commands/);
  assert.match(viewMenu, /open-review/);
  assert.match(viewMenu, /open-browser/);
  assert.match(viewMenu, /toggle-companion/);
  assert.doesNotMatch(viewMenu, /role:\s*"close"|role:\s*"reload"/);
  assert.match(appShellSource, /case "settings"/);
  assert.match(appShellSource, /case "open-browser"/);
  assert.doesNotMatch(appShellSource, /sidebar-user-menu|sidebarMenuOpen|currentModelInfo/);
  assert.doesNotMatch(appShellSource, /themeBtnRef|languageBtnRef|app-topbar-appearance/);
});

test("web chrome exposes a Codex-style draggable menu strip without swallowing controls", () => {
  assert.match(appShellSource, /setDesktopChrome\(Boolean\(window\.piDesktop\)\)/);
  assert.match(appShellSource, /app-shell\$\{desktopChrome \? " desktop-chrome" : ""\}/);
  assert.match(appShellSource, /className="desktop-titlebar"/);
  assert.match(globalStyles, /\.app-shell\.desktop-chrome \.desktop-titlebar[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(globalStyles, /\.desktop-titlebar-menu[\s\S]*-webkit-app-region:\s*no-drag/);
  assert.match(globalStyles, /env\(titlebar-area-x,\s*0px\)/);
  assert.match(globalStyles, /env\(titlebar-area-width,\s*100vw\)/);
});

test("Mermaid viewer stays below the native desktop window controls", () => {
  assert.match(mermaidBlockSource, /Boolean\(window\.piDesktop\)/);
  assert.match(mermaidBlockSource, /data-desktop-chrome=\{hasDesktopChrome \? "true" : undefined\}/);
  assert.match(
    globalStyles,
    /\.mermaid-zoom-dialog\[data-desktop-chrome="true"\][\s\S]*?inset:\s*36px 0 0;[\s\S]*?max-height:\s*calc\(100dvh - 84px\);/,
  );
  assert.match(
    globalStyles,
    /\.mermaid-zoom-dialog\[data-desktop-chrome="true"\]::backdrop[\s\S]*?transparent 0 36px/,
  );
});
