import type { MirrorScale } from "./harmony-window-types.js";
export const MIRROR_TITLE_HEIGHT = 36;
type Bounds = { x: number; y: number; width: number; height: number };
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
  scale: MirrorScale, position?: { x: number; y: number }) {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 20) ratio = 9 / 20;
  const heightAtFit = Math.max(1, Math.min(area.height - 32 - MIRROR_TITLE_HEIGHT - 2, (area.width - 34) / ratio));
  const width = Math.round(heightAtFit * ratio * scale / 100) + 2;
  const height = Math.round(heightAtFit * scale / 100) + MIRROR_TITLE_HEIGHT + 2;
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, position?.x ?? area.x + area.width - width - 16))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, position?.y ?? area.y + 16))),
  };
}
