import { HarmonyError } from "../errors";

export interface NativeDisplayGeometry {
  nativeWidth: number;
  nativeHeight: number;
  displayId: string;
  displayRotation: 0 | 90 | 180 | 270;
}

export interface HarmonyGeometry extends NativeDisplayGeometry {
  geometryId: string;
  deviceEpoch: number;
  frameWidth: number;
  frameHeight: number;
  /** Clockwise rotation of the cropped native image within the encoded frame. */
  rotation: 0 | 90 | 180 | 270;
  crop: { left: number; top: number; width: number; height: number };
}

export function transformFramePoint(geometry: HarmonyGeometry, x: number, y: number) {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= geometry.frameWidth || y >= geometry.frameHeight) {
    throw new HarmonyError("INVALID_ARGUMENT", "Point is outside the referenced frame");
  }
  let u = x / geometry.frameWidth;
  let v = y / geometry.frameHeight;
  if (geometry.rotation === 90) [u, v] = [v, 1 - u];
  else if (geometry.rotation === 180) [u, v] = [1 - u, 1 - v];
  else if (geometry.rotation === 270) [u, v] = [1 - v, u];
  const crop = geometry.crop;
  if (crop.left < 0 || crop.top < 0 || crop.width <= 0 || crop.height <= 0
    || crop.left + crop.width > geometry.nativeWidth || crop.top + crop.height > geometry.nativeHeight) {
    throw new HarmonyError("INVALID_ARGUMENT", "Frame crop is outside native input geometry");
  }
  return {
    x: Math.min(geometry.nativeWidth - 1, Math.round(crop.left + u * crop.width)),
    y: Math.min(geometry.nativeHeight - 1, Math.round(crop.top + v * crop.height)),
  };
}

/** CSS client pixels are independent of device pixel ratio and encoded pixels. */
export function framePointFromClient(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, frameWidth: number, frameHeight: number) {
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const left = rect.left + (rect.width - frameWidth * scale) / 2;
  const top = rect.top + (rect.height - frameHeight * scale) / 2;
  const px = (x - left) / scale;
  const py = (y - top) / scale;
  return px >= 0 && py >= 0 && px < frameWidth && py < frameHeight ? { x: Math.floor(px), y: Math.floor(py) } : null;
}

/** OpenHarmony dmserver DisplayDumper table; unknown/multiple displays stay unsupported. */
export function parseDisplayGeometry(output: string): NativeDisplayGeometry | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex(line => /DisplayId\s+.*Rotation.*\[/.test(line));
  if (start < 0) {
    // ScreenSessionDumper also prints DisplayId in user/display relation sections.
    // Scope identity to SCREEN SESSION, never count those unrelated repeated IDs.
    const sessions = [...output.matchAll(/^\s*\[SCREEN SESSION\]\s*$\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)];
    const properties = [...output.matchAll(/^\s*\[SCREEN PROPERTY\]\s*$\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)];
    if (sessions.length !== 1 || properties.length !== 1 || properties[0].index! < sessions[0].index!) return undefined;
    const ids = [...sessions[0][1].matchAll(/^\s*DisplayId:\s*(\d+)\s*$/gm)];
    if (ids.length !== 1) return undefined;
    const section = properties[0][1];
    const bounds = section.match(/^\s*Bounds<L,T,W,H>:\s*0(?:\.0+)?,\s*0(?:\.0+)?,\s*(\d+)(?:\.0+)?,\s*(\d+)(?:\.0+)?,?\s*$/m);
    const rotation = section.match(/^\s*ScreenRotation:\s*([0-3])\s*$/m);
    if (!bounds || !rotation) return undefined;
    const nativeWidth = Number(bounds[1]), nativeHeight = Number(bounds[2]);
    if (nativeWidth < 1 || nativeHeight < 1 || nativeWidth > 16_384 || nativeHeight > 16_384) return undefined;
    return { nativeWidth, nativeHeight, displayId: ids[0][1], displayRotation: (Number(rotation[1])*90) as NativeDisplayGeometry["displayRotation"] };
  }
  const rows = lines.slice(start + 1).map(line => line.match(/^\s*(\d+)\s+\d+\s+[\d.]+\s+[\d.]+\s+([0-3])\s+\d+\s+\d+\s+\d+\s+\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/)).filter(match => match !== null);
  if (rows.length !== 1) return undefined;
  const [, displayId, rotation, width, height] = rows[0];
  const nativeWidth = Number(width), nativeHeight = Number(height);
  if (nativeWidth < 1 || nativeHeight < 1 || nativeWidth > 16_384 || nativeHeight > 16_384) return undefined;
  return { nativeWidth, nativeHeight, displayId, displayRotation: (Number(rotation) * 90) as NativeDisplayGeometry["displayRotation"] };
}
