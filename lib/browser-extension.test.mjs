import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const extension = readFileSync(new URL("../extensions/piora-browser.ts", import.meta.url), "utf8");
const desktopBrowser = readFileSync(new URL("../desktop/src/browser-manager.ts", import.meta.url), "utf8");
const browserPanel = readFileSync(new URL("../components/workspace/BrowserPanel.tsx", import.meta.url), "utf8");
const desktopPreload = readFileSync(new URL("../desktop/src/preload.ts", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const staging = readFileSync(new URL("../scripts/stage-standalone.mjs", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { FIRST_PARTY_EXTENSIONS } = await jiti.import("./first-party-extensions.ts");

test("loads the built-in browser with a visible panel and persistent Piora profile", () => {
  assert.equal(
    FIRST_PARTY_EXTENSIONS.some(({ id, fileName, profiles }) => (
      id === "piora:browser"
      && fileName === "piora-browser.ts"
      && profiles.includes("normal")
      && !profiles.includes("device-control")
    )),
    true,
  );
  assert.match(extension, /name: "browser"/);
  assert.match(extension, /launchPersistentContext/);
  assert.match(extension, /browser-profile/);
  assert.match(extension, /context\.cookies\(\)/);
  assert.doesNotMatch(extension, /context\.storageState\(/);
  assert.doesNotMatch(extension, /context\.setStorageState/);
  assert.match(extension, /context\.addCookies\(missing\)/);
  assert.doesNotMatch(extension, /existing\.context\.close/);
  assert.match(extension, /page\.on\("domcontentloaded"/);
  const transientPointerActions = extension.match(/const transientPointerAction = ([^;]+);/)?.[1] ?? "";
  assert.doesNotMatch(transientPointerActions, /mouse_up/);
  assert.match(extension, /getBrowserViewScreenshot/);
  assert.match(extension, /page\.setViewportSize/);
  assert.match(extension, /case "mouse_move"/);
  assert.match(extension, /page\.mouse\.down/);
  assert.match(extension, /page\.mouse\.up/);
  assert.match(extension, /sessions: new Map\(\)/);
  assert.match(extension, /own persistent \$\{APP_DISPLAY_NAME\} profile/);
  assert.match(extension, /piora_runtime_capability name="browser" availability="active"/);
  assert.match(extension, /systemPrompt: `\$\{event\.systemPrompt\}/);
  assert.match(extension, /selectedTools\?\.includes\("browser"\)/);
  assert.equal(extension.includes('if (!/(?:https?://|www.'), false);
  assert.match(extension, /independent background Chrome\/Edge browser/);
});

test("packages the extension and Playwright runtime for desktop builds", () => {
  assert.match(staging, /extensions\/piora-browser\.ts/);
  assert.match(staging, /node_modules", "playwright-core/);
});

test("embeds a live Chromium view inside the existing desktop browser panel", () => {
  assert.match(desktopBrowser, /new WebContentsView/);
  assert.match(desktopBrowser, /persist:piora-browser/);
  assert.match(desktopBrowser, /flushStorageData\(\)/);
  assert.match(desktopBrowser, /cookies\.flushStore\(\)/);
  assert.match(desktopBrowser, /cookies\.on\("changed"/);
  assert.match(desktopBrowser, /setDownloadPath\(app\.getPath\("downloads"\)\)/);
  assert.match(desktopBrowser, /BROWSER_VIEWPORT_CHANNEL/);
  assert.match(desktopPreload, /browser: Object\.freeze/);
  assert.match(browserPanel, /DesktopBrowserPanel/);
  assert.match(browserPanel, /ScreenshotBrowserPanel/);
  assert.match(browserPanel, /AgentBrowserPanel/);
  assert.match(browserPanel, /getBoundingClientRect/);
  assert.match(browserPanel, /useLayoutEffect/);
  assert.match(browserPanel, /panelActiveRef\.current && visible/);
  assert.match(desktopMain, /await desktopBrowserManager\?\.flushStorage\(\)/);
});

test("independent and Agent browser modes keep separate tab ownership", () => {
  assert.doesNotMatch(extension, /desktopBrowserRpcAvailable|requestDesktopBrowser|readBrowserConfig/);
  assert.doesNotMatch(desktopMain, /pi-desktop:browser-request|performAgentAction/);
  assert.doesNotMatch(desktopBrowser, /performAgentAction/);
  assert.match(extension, /const UI_SESSION_ID = "__piora_browser_ui__"/);
  assert.match(extension, /function sessionPages\(session: BrowserSession\)/);
  assert.match(extension, /right sidebar's independent browser/);
  assert.match(desktopBrowser, /sessionId: string/);
  assert.match(desktopBrowser, /displayedSessionId/);
  assert.match(desktopBrowser, /input\.action === "set_session"/);
  assert.match(browserPanel, /action: "set_session"/);
  assert.match(browserPanel, /role="switch" aria-checked=\{followAgent\}/);
  assert.match(browserPanel, /<AgentBrowserPanel active=\{active\} sessionId=\{sessionId\}/);
  assert.match(browserPanel, /followAgent\s*\?\s*<AgentBrowserPanel/);
  assert.match(browserPanel, /desktopLinked \? null/);
  assert.match(extension, /action: "wait_for_user"/);
  assert.match(extension, /desktopEvaluateRequest\(\{\s*hasUI:/);
  assert.doesNotMatch(extension, /confirmed: Type/);
  assert.doesNotMatch(browserPanel, /useBrowserMode|\/api\/browser\/settings/);
  assert.doesNotMatch(extension, /setRightPanelOpen|onOpenBrowser|BROWSER_VIEWPORT_CHANNEL/);
});

test("desktop browser unmount disposes its viewport before DOM refs disappear", () => {
  assert.match(browserPanel, /useLayoutEffect\(\(\) => \{\s+const sync = createBrowserViewportSync/);
  assert.match(browserPanel, /return \(\) => \{[^}]*sync\.dispose\(\)/);
  assert.match(browserPanel, /viewportSyncRef\.current\?\.sync/);
  assert.doesNotMatch(browserPanel, /pendingViewportRef|viewportSyncInFlightRef/);
});

test("Chrome onboarding imports bookmarks without reading cookies or passwords", () => {
  assert.match(desktopBrowser, /join\(userData, profile, "Bookmarks"\)/);
  assert.doesNotMatch(desktopBrowser, /Cookies|Login Data|password_value/);
  assert.match(desktopBrowser, /parsed\.roots\?\.bookmark_bar/);
  assert.doesNotMatch(desktopBrowser, /Object\.entries\(parsed\.roots\)/);
  assert.match(desktopBrowser, /type: "folder"/);
  assert.doesNotMatch(desktopBrowser, /MAX_BOOKMARKS|bookmarks\.length >=/);
  assert.match(browserPanel, /browser\.importSafety/);
  assert.match(browserPanel, /BROWSER_ONBOARDING_KEY/);
  assert.match(browserPanel, /browserBookmarkBar/);
  assert.match(browserPanel, /bridge\.showBookmarkMenu/);
  assert.doesNotMatch(browserPanel, /browserBookmarkDrawer|function BookmarkTree/);
  assert.match(browserPanel, /profiles\.flatMap\(\(profile\) => profile\.children\)/);
  assert.doesNotMatch(browserPanel, /id: `profile:/);
  assert.doesNotMatch(browserPanel, /bookmarks\.slice\(/);
});
