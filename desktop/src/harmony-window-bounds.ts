import type { MirrorScale } from "./harmony-window-types.js";
export const MIRROR_TITLE_HEIGHT = 36;
type Bounds = { x: number; y: number; width: number; height: number };
/** Windows applies its native aspect constraint immediately to the outer
 * window. Maintain video geometry in will-resize there instead, so changing
 * toolbar height cannot briefly widen the window and wrap the toolbar again. */
export async function updateMirrorAspectRatio(window: {
  getBounds(): Bounds; setBounds(bounds: Bounds, animate: boolean): void;
  setAspectRatio(ratio: number, extra: { width: number; height: number }): void;
}, ratio: number, chromeHeight: number, target: Bounds): Promise<Bounds> {
  window.setAspectRatio(process.platform === "win32" ? 0 : ratio, { width: 2, height: chromeHeight });
  return applyMirrorBounds(window, target);
}

export function mirrorResizeBounds(current: Bounds, requested: Bounds, ratio: number, chromeHeight: number, edge: string): Bounds {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 20) ratio = 9 / 20;
  const vertical = edge === "top" || edge === "bottom";
  const videoHeight = Math.max(1, 120 - chromeHeight, (180 - 2) / ratio,
    vertical ? requested.height - chromeHeight : (requested.width - 2) / ratio);
  const width = Math.round(videoHeight * ratio) + 2, height = Math.round(videoHeight) + chromeHeight;
  return { width, height,
    x: edge.includes("left") ? current.x + current.width - width : current.x,
    y: edge.includes("top") ? current.y + current.height - height : current.y };
}
/** Win32 can round both physical edges outwards. Correct against the absolute DIP target,
 * never against the size left by the previous drag, and bound the correction work. */
export async function applyMirrorBounds(window: { setBounds(bounds: Bounds, animate: boolean): void; getBounds(): Bounds }, target: Bounds): Promise<Bounds> {
  const requested = { ...target };
  let actual = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    window.setBounds(requested, false);
    // Win32 may apply the final physical-edge rounding after setBounds returns.
    await new Promise(resolve => setTimeout(resolve, 16));
    actual = window.getBounds();
    const keys = ["x", "y", "width", "height"] as const;
    if (keys.every(key => Math.abs(actual[key] - target[key]) <= 1)) break;
    for (const key of keys) if (Math.abs(actual[key] - target[key]) > 1) requested[key] += Math.sign(target[key] - actual[key]);
  }
  return actual;
}
export function mirrorBounds(area: { x: number; y: number; width: number; height: number }, ratio: number,
  scale: MirrorScale, position?: { x: number; y: number }, chromeHeight = MIRROR_TITLE_HEIGHT + 2) {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 20) ratio = 9 / 20;
  const heightAtFit = Math.max(1, Math.min(area.height - 32 - chromeHeight, (area.width - 34) / ratio));
  const width = Math.round(heightAtFit * ratio * scale / 100) + 2;
  const height = Math.round(heightAtFit * scale / 100) + chromeHeight;
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, position?.x ?? area.x + area.width - width - 16))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, position?.y ?? area.y + 16))),
  };
}
