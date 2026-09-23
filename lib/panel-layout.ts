export const MOBILE_MAX_WIDTH = 640;
export const RIGHT_PANEL_OVERLAY_MAX_WIDTH = 1439;
export const SPLIT_PANEL_MIN_WIDTH = RIGHT_PANEL_OVERLAY_MAX_WIDTH + 1;
export const WORKSPACE_MIN_WIDTH = 640;
export const CHAT_MIN_WIDTH_WITH_RIGHT_PANEL = 480;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 3200;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 420;
export const RIGHT_PANEL_MAX_WIDTH = 2400;

const DESKTOP_PANEL_GUTTER_RESERVE = 32;
const SIDEBAR_MAX_VIEWPORT_RATIO = 0.66;

export function isRightPanelOverlayViewport(viewportWidth: number): boolean {
  return viewportWidth > MOBILE_MAX_WIDTH && viewportWidth < SPLIT_PANEL_MIN_WIDTH;
}

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.5, 560, 960);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const overlay = isRightPanelOverlayViewport(viewportWidth);
  const visibleRightPanelWidth = !overlay && rightPanelOpen ? rightPanelWidth : 0;
  const gutterReserve = overlay ? 0 : DESKTOP_PANEL_GUTTER_RESERVE;
  const proportionalMaxWidth = Math.floor(viewportWidth * SIDEBAR_MAX_VIEWPORT_RATIO);
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    proportionalMaxWidth,
    viewportWidth - (visibleRightPanelWidth ? CHAT_MIN_WIDTH_WITH_RIGHT_PANEL : WORKSPACE_MIN_WIDTH) - visibleRightPanelWidth - gutterReserve,
  );
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (isRightPanelOverlayViewport(viewportWidth)) return Math.min(RIGHT_PANEL_MAX_WIDTH, viewportWidth - 48);

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - CHAT_MIN_WIDTH_WITH_RIGHT_PANEL - visibleSidebarWidth - DESKTOP_PANEL_GUTTER_RESERVE,
  );
}
