import type { BrowserWindow, Rectangle, Screen } from "electron";
import { clampCompanionBounds } from "./companion-motion.js";

export function sanitizeCompanionHitRegion(input: unknown, size: { width: number; height: number }): Rectangle | null {
  if (!input || typeof input !== "object") return null;
  const rect = input as Rectangle;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.max(0, Math.min(size.width, rect.x));
  const y = Math.max(0, Math.min(size.height, rect.y));
  const right = Math.max(x, Math.min(size.width, rect.x + rect.width));
  const bottom = Math.max(y, Math.min(size.height, rect.y + rect.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Fixed DIP geometry and native cursor polling; no accumulating forwarded mouse hooks. */
export function guardCompanionWindow(window: BrowserWindow, screen: Screen, size: { width: number; height: number }, now = Date.now) {
  let region: Rectangle | null = null;
  let regionAt = 0;
  let dragAt: number | null = null;
  let ignoring = true;
  window.setIgnoreMouseEvents(true);
  const setIgnoring = (next: boolean) => {
    if (next === ignoring || window.isDestroyed()) return;
    ignoring = next; window.setIgnoreMouseEvents(next);
  };
  const place = (point: { x: number; y: number }) => {
    if (window.isDestroyed()) return;
    const current = window.getBounds();
    const area = screen.getDisplayNearestPoint({ x: point.x + size.width / 2, y: point.y + size.height / 2 }).workArea;
    // Never reuse native width/height as the next desired size: DPI changes
    // can otherwise ratchet those values up across repeated monitor changes.
    const fitted = clampCompanionBounds({ ...point, ...size }, area);
    if (current.width !== size.width || current.height !== size.height) window.setBounds(fitted, false);
    else if (current.x !== fitted.x || current.y !== fitted.y) window.setPosition(fitted.x, fitted.y, false);
    return fitted;
  };
  const reset = () => { region = null; dragAt = null; setIgnoring(true); };
  const sync = () => {
    if (window.isDestroyed()) return;
    const bounds = place(window.getBounds());
    if (!bounds || !window.isVisible() || !region || now() - regionAt > 1500) { setIgnoring(true); return; }
    const pointer = screen.getCursorScreenPoint();
    const x = pointer.x - bounds.x, y = pointer.y - bounds.y;
    const inWindow = x >= 0 && y >= 0 && x < size.width && y < size.height;
    const dragging = dragAt !== null && now() - dragAt < 1500;
    const hit = x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
    setIgnoring(!(inWindow && (dragging || hit)));
  };
  const timer = setInterval(sync, 50);
  timer.unref();
  window.webContents.on("did-start-loading", reset);
  window.webContents.on("render-process-gone", reset);
  window.on("unresponsive", reset);
  window.on("hide", reset);
  window.on("closed", () => clearInterval(timer));
  return {
    place, sync, reset,
    setDragging(active: boolean) { dragAt = active ? now() : null; sync(); },
    updateHitRegion(input: unknown) {
      region = sanitizeCompanionHitRegion(input, size); regionAt = now(); sync(); return region !== null;
    },
  };
}
