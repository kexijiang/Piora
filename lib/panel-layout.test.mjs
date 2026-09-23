import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clampPanelWidth,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  isRightPanelOverlayViewport,
  SPLIT_PANEL_MIN_WIDTH,
  WORKSPACE_MIN_WIDTH,
  CHAT_MIN_WIDTH_WITH_RIGHT_PANEL,
} = await jiti.import("./panel-layout.ts");
const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("clamps panel widths to finite bounds", () => {
  assert.equal(clampPanelWidth(420.4, 180, 480), 420);
  assert.equal(clampPanelWidth(120, 180, 480), 180);
  assert.equal(clampPanelWidth(600, 180, 480), 480);
  assert.equal(clampPanelWidth(Number.NaN, 180, 480), 180);
  assert.equal(clampPanelWidth(200, 300, 250), 300);
});

test("keeps the responsive right panel default within useful limits", () => {
  assert.equal(getDefaultRightPanelWidth(700), 560);
  assert.equal(getDefaultRightPanelWidth(1366), 683);
  assert.equal(getDefaultRightPanelWidth(1920), 960);
});

test("reserves chat space while split panels are visible", () => {
  assert.equal(WORKSPACE_MIN_WIDTH, 640);
  assert.equal(CHAT_MIN_WIDTH_WITH_RIGHT_PANEL, 480);
  assert.equal(SPLIT_PANEL_MIN_WIDTH, 1440);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 700,
    rightPanelOpen: true,
    rightPanelWidth: 560,
  }), 60);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1440,
    rightPanelOpen: true,
    rightPanelWidth: 508,
  }), 420);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1440,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 668);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1920,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 1148);
});

test("lets the project sidebar grow across most of a desktop window", () => {
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1440,
    rightPanelOpen: false,
    rightPanelWidth: 0,
  }), 768);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1920,
    rightPanelOpen: false,
    rightPanelWidth: 0,
  }), 1248);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 2560,
    rightPanelOpen: false,
    rightPanelWidth: 0,
  }), 1689);
});

test("does not rewrite desktop widths while the file panel is in overlay mode", () => {
  assert.equal(isRightPanelOverlayViewport(1280), true);
  assert.equal(isRightPanelOverlayViewport(1439), true);
  assert.equal(isRightPanelOverlayViewport(1440), false);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1280,
    sidebarOpen: true,
    sidebarWidth: 480,
  }), 1232);
});

test("CSS uses the shared workspace minimum and matching overlay breakpoint", () => {
  assert.match(globalCss, /\.workspace-main\s*\{[^}]*min-width:\s*var\(--workspace-min-width,\s*640px\)/s);
  assert.match(globalCss, /@media \(min-width:\s*641px\) and \(max-width:\s*1439px\)/);
});

test("closed side panels leave no edge chrome", () => {
  assert.match(
    globalCss,
    /\.sidebar-container\.sidebar-closed,\s*\.right-panel-container\.right-panel-closed\s*\{[^}]*border:\s*0\s*!important;[^}]*box-shadow:\s*none\s*!important;/s,
  );
  assert.match(
    globalCss,
    /\.sidebar-container\.sidebar-open,\s*\.workspace-main,\s*\.right-panel-container\.right-panel-open\s*\{[^}]*border:\s*0\s*!important;/s,
  );
  assert.doesNotMatch(globalCss, /\.workspace-main\s*\{[^}]*border-(?:left|right):\s*1px/s);
});
