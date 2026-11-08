import type { BrowserWindow, Rectangle, Screen } from "electron";
import { clampCompanionBounds, nativeCompanionPoint, validCompanionRectangle } from "./companion-motion.js";

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
export function guardCompanionWindow(window: BrowserWindow, screen: Screen, size: { width: number; height: number }, now = Date.now, onError: (error: unknown) => void = () => {}) {
  let region: Rectangle | null = null;
  let regionAt = 0;
  let dragAt: number | null = null;
  let ignoring = true;
  let lastErrorAt = -Infinity;
  const protect = <T>(action: () => T): T | undefined => {
    try { return action(); } catch (error) {
      // A transient display failure can affect every 50 ms poll. Keep diagnostics bounded.
      if (now() - lastErrorAt >= 5_000) { lastErrorAt = now(); onError(error); }
      return undefined;
    }
  };
  protect(() => window.setIgnoreMouseEvents(true));
  const setIgnoring = (next: boolean) => {
    if (next === ignoring || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(next); ignoring = next;
  };
  const placeUnsafe = (point: { x: number; y: number }) => {
    if (window.isDestroyed()) return;
    const position = nativeCompanionPoint(point);
    if (!position || !validCompanionRectangle({ ...position, ...size })) throw new RangeError("Invalid companion position or size");
    const current = window.getBounds();
    const center = nativeCompanionPoint({ x: position.x + size.width / 2, y: position.y + size.height / 2 });
    if (!center) throw new RangeError("Invalid companion display point");
    const area = screen.getDisplayNearestPoint(center).workArea;
    if (!validCompanionRectangle(area)) throw new RangeError("Invalid companion display work area");
    // Never reuse native width/height as the next desired size: DPI changes
    // can otherwise ratchet those values up across repeated monitor changes.
    const fitted = clampCompanionBounds({ ...position, ...size }, area);
    if (!validCompanionRectangle(fitted)) throw new RangeError("Invalid fitted companion bounds");
    if (current.width !== size.width || current.height !== size.height) window.setBounds(fitted, false);
    else if (current.x !== fitted.x || current.y !== fitted.y) window.setPosition(fitted.x, fitted.y, false);
    return fitted;
  };
  const place = (point: { x: number; y: number }) => protect(() => placeUnsafe(point));
  const reset = () => protect(() => { region = null; dragAt = null; setIgnoring(true); });
  const sync = () => protect(() => {
    if (window.isDestroyed()) return;
    const bounds = place(window.getBounds());
    if (!bounds || !window.isVisible() || !region || now() - regionAt > 1500) { setIgnoring(true); return; }
    const pointer = screen.getCursorScreenPoint();
    const x = pointer.x - bounds.x, y = pointer.y - bounds.y;
    const inWindow = x >= 0 && y >= 0 && x < size.width && y < size.height;
    const dragging = dragAt !== null && now() - dragAt < 1500;
    const hit = x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
    setIgnoring(!(inWindow && (dragging || hit)));
  });
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
