import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [builder, previewBuilder, main, preload, appShell, updateDialog, styles, releaseWorkflow, previewWorkflow, desktopPackage] = await Promise.all([
  readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8"),
  readFile(new URL("../desktop/electron-builder.preview.yml", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/preload.ts", import.meta.url), "utf8"),
  readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../components/DesktopUpdateDialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/harmony-preview.yml", import.meta.url), "utf8"),
  readFile(new URL("../desktop/package.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("Windows installer lets users choose a location and preserves application data", () => {
  assert.match(builder, /- target: nsis/);
  assert.match(builder, /nsis:\s*[\s\S]*?oneClick: false/);
  assert.match(builder, /allowToChangeInstallationDirectory: true/);
  assert.match(builder, /perMachine: false/);
  assert.match(builder, /createDesktopShortcut: true/);
  assert.doesNotMatch(builder, /createDesktopShortcut: always/);
  assert.match(builder, /deleteAppDataOnUninstall: false/);
  assert.match(builder, /artifactName: \$\{productName\}-\$\{version\}-win-x64-setup\.\$\{ext\}/);
});

test("installed Piora checks GitHub releases without silently installing", () => {
  assert.equal(desktopPackage.dependencies["electron-updater"], "6.8.9");
  assert.match(builder, /publish:\s*[\s\S]*?provider: github[\s\S]*?owner: kexijiang[\s\S]*?repo: Piora/);
  assert.match(main, /supported = app\.isPackaged[\s\S]*?process\.platform === "win32"/);
  assert.match(main, /!process\.env\.PORTABLE_EXECUTABLE_FILE/);
  assert.match(main, /automaticUpdateCheckTimer = setTimeout/);
  assert.match(main, /runningTaskCount > 0/);
  assert.match(main, /await shutdownPromise[\s\S]*?quitAndInstall\(\)/);
  assert.match(main, /readOrCreateDesktopReleaseAudience/);
  assert.match(main, /preparePreviewUpdateFeed/);
});

test("the title bar opens the in-app update experience", () => {
  assert.match(main, /updateAvailable: "有更新"/);
  assert.match(main, /restartToInstall: "安装并重启"/);
  assert.match(preload, /pi:update-state-get/);
  assert.match(preload, /pi:update-state/);
  assert.match(preload, /pi:update-download/);
  assert.match(preload, /pi:update-install/);
  assert.match(appShell, /desktop-titlebar-update-button/);
  assert.match(appShell, /desktop-titlebar-menus[\s\S]*desktop-titlebar-update-button[\s\S]*desktop-titlebar-drag/);
  assert.match(appShell, /DesktopUpdateDialog/);
  assert.match(updateDialog, /本次更新/);
  assert.match(updateDialog, /已是最新版本/);
  assert.match(main, /checked\.status === "up-to-date"[\s\S]*focusMainWindow\("open-update"\)/);
  assert.doesNotMatch(main, /message: chinese \? "当前已经是最新版本"/);
  assert.match(updateDialog, /安装并重启/);
  assert.match(updateDialog, /role="progressbar"/);
  assert.match(updateDialog, /releaseNotes/);
  assert.match(styles, /\.desktop-titlebar-update-button/);
});

test("release workflow verifies and publishes updater metadata with the installer", () => {
  assert.match(releaseWorkflow, /verify-windows-update-artifacts\.mjs desktop\/release/);
  assert.match(releaseWorkflow, /Install and smoke-test NSIS application/);
  assert.match(releaseWorkflow, /\*-setup\.exe\.blockmap/);
  assert.match(releaseWorkflow, /desktop\/release\/latest\.yml/);
  assert.match(releaseWorkflow, /Piora-\$version-win-x64-setup\.exe/);
  assert.match(releaseWorkflow, /create-release-notes\.mjs/);
  assert.match(releaseWorkflow, /piora-release-notes-\$\{\{ github\.ref_name \}\}/);
  assert.match(releaseWorkflow, /--notes-file \$releaseNotesPath/);
});

test("preview workflow publishes an installable beta channel alongside the portable build", () => {
  assert.match(previewBuilder, /extends: electron-builder\.yml/);
  assert.match(previewBuilder, /releaseType: prerelease/);
  assert.match(previewBuilder, /channel: beta/);
  assert.match(previewWorkflow, /v\*-beta\.\*/);
  assert.match(previewWorkflow, /npm run dist:win:preview/);
  assert.match(previewWorkflow, /verify-windows-update-artifacts\.mjs desktop\/release/);
  assert.match(previewWorkflow, /Install and smoke-test preview installer/);
  assert.match(previewWorkflow, /desktop\/release\/\*-setup\.exe/);
  assert.match(previewWorkflow, /desktop\/release\/beta\.yml/);
  assert.match(previewWorkflow, /create-release-notes\.mjs/);
  assert.match(previewWorkflow, /--notes-file \$releaseNotesPath/);
  assert.match(previewWorkflow, /--prerelease/);
});
