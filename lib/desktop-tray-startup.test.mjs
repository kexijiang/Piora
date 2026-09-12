import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const builderConfig = readFileSync(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");
const packageVerifier = readFileSync(new URL("../scripts/verify-packaged-web.mjs", import.meta.url), "utf8");
const beforeBuild = readFileSync(new URL("../scripts/electron-before-build.cjs", import.meta.url), "utf8");
const afterPack = readFileSync(new URL("../scripts/electron-after-pack-licenses.cjs", import.meta.url), "utf8");
const supervisor = readFileSync(new URL("../desktop/src/server-supervisor.ts", import.meta.url), "utf8");
const portableTemplate = readFileSync(new URL("../desktop/build/portable-cache.nsi", import.meta.url), "utf8");

test("the packaged desktop app ships and installs a reliable system tray icon", () => {
  assert.match(builderConfig, /from:\s*build\/icon\.ico[\s\S]*?to:\s*tray-icon\.ico/);
  assert.match(mainSource, /join\(process\.resourcesPath,\s*"tray-icon\.ico"\)/);
  assert.match(packageVerifier, /await assertFile\(trayIconPath\)/);
  assert.match(mainSource, /tray\s*=\s*new Tray\(/);
  assert.match(mainSource, /tray\.on\("click",\s*\(\)\s*=>\s*focusMainWindow\(\)\)/);
  assert.ok(
    mainSource.indexOf("installTray();") < mainSource.indexOf("serverUrl = await server.start();"),
    "the tray should be available while the bundled service starts",
  );
});

test("closing the main window keeps Piora in the tray and the tray can quit completely", () => {
  assert.match(
    mainSource,
    /window\.on\("close",[\s\S]*?if \(quitRequested \|\| PORTABLE_SMOKE_TEST\) return;[\s\S]*?event\.preventDefault\(\);[\s\S]*?window\.hide\(\);/,
  );
  assert.match(mainSource, /"Quit Piora completely"[\s\S]*?quitRequested = true;[\s\S]*?app\.quit\(\);/);
  assert.match(mainSource, /app\.on\("before-quit",[\s\S]*?quitRequested = true;/);
  assert.doesNotMatch(mainSource, /app\.on\("window-all-closed",\s*\(\)\s*=>\s*app\.quit\(\)\)/);
});

test("startup reuses the visible shell without inflating the portable payload", () => {
  assert.match(builderConfig, /^compression:\s*normal$/m);
  assert.match(builderConfig, /electronLanguages:\s*\n\s+- en-US\s*\n\s+- zh-CN/);
  assert.match(mainSource, /const startup = createStartupWindow\(logger\);\s*mainWindow = startup\.window;/);
  assert.match(mainSource, /await loadApplicationWindow\(mainWindow, serverUrl, logger\);/);
  assert.doesNotMatch(mainSource, /startup\.window\.destroy\(\)/);
  assert.match(builderConfig, /beforeBuild:\s*\.\.\/scripts\/electron-before-build\.cjs/);
  assert.match(beforeBuild, /electron-updater[\s\S]*?return true/);
  assert.match(beforeBuild, /STOCK_PORTABLE_TEMPLATE_SHA256/);
  assert.match(beforeBuild, /PIORA_PORTABLE_CACHE_TEMPLATE_V1/);
  assert.match(afterPack, /createWebRuntimeArchive\(webRoot, temporaryArchive\)/);
  assert.match(afterPack, /rm\(webRoot, \{ recursive: true, force: true \}\)/);
  assert.match(afterPack, /const dir = path\.join\(__dirname, 'runtime\.asar'\)/);
  assert.match(mainSource, /Packaged web runtime archive is missing/);
  assert.match(supervisor, /NODE_PATH: this\.options\.nodePath/);
  assert.match(packageVerifier, /NODE_PATH: join\(isolatedWebRoot, "runtime\.asar", "node_modules"\)/);
  assert.match(portableTemplate, /\$LOCALAPPDATA\\Piora\\portable\\\$\{UNPACK_DIR_NAME\}/);
  assert.match(portableTemplate, /\.piora-runtime-ready/);
  assert.doesNotMatch(portableTemplate, /SectionEnd[\s\S]*?RMDir \/r \$INSTDIR/);
  assert.equal(
    (mainSource.match(/new BrowserWindow\(/g) ?? []).length,
    4,
    "only the reusable main shell and the three independent companion surfaces should allocate BrowserWindows",
  );
});

test("startup defers secondary UI and does not run an endless loading animation", () => {
  const appShellSource = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  for (const component of [
    "ModelsConfig",
    "SkillsConfig",
    "PluginsConfig",
    "CompanionSettingsDialog",
    "SessionHistoryWorkbench",
    "CommandPalette",
  ]) {
    assert.match(appShellSource, new RegExp(`dynamic\\(\\(\\) => import\\(\\"\\./${component}\\"\\)`));
  }
  assert.match(appShellSource, /const settingsPage = settingsDialogOpen \?/);
  assert.match(appShellSource, /\{commandPaletteOpen \? \(/);
  const startupSource = readFileSync(new URL("../desktop/src/startup-scene.ts", import.meta.url), "utf8");
  assert.doesNotMatch(startupSource, /animation:[^;}]* infinite/);
  assert.doesNotMatch(startupSource, /playsinline loop/);
  assert.match(startupSource, /animation:sweep 1\.8s ease-in-out 6 both/);
});

test("desktop warms the initial model catalog before navigating to the landing page", () => {
  assert.match(mainSource, /function warmInitialModelCatalog\(/);
  assert.match(mainSource, /fetch\(new URL\("\/api\/models", url\)/);
  assert.match(mainSource, /headers: \{ \[DESKTOP_TOKEN_HEADER\]: token \}/);
  const warmupCall = mainSource.indexOf("warmInitialModelCatalog(serverUrl, token, logger);");
  const landingNavigation = mainSource.lastIndexOf("await loadApplicationWindow(mainWindow, serverUrl, logger);");
  assert.ok(warmupCall >= 0 && warmupCall < landingNavigation);
});
