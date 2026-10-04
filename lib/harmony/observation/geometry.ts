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

/** Only one verified real display may provide coordinates; virtual capture displays are not input targets. */
export function parseDisplayGeometry(output: string): NativeDisplayGeometry | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex(line => /DisplayId\s+.*Rotation.*\[/.test(line));
  if (start < 0) {
    // Modern dumps repeat SCREEN PROPERTY in client diagnostics. Bind sections
    // to a Screen ID record, stopping before the independent Display ID dump.
    const markers = [...output.matchAll(/^[ \t]*-+[ \t]*Screen ID:[ \t]*(\d+)[ \t]*-+[ \t]*\r?$/gm)];
    const records = markers.length ? markers.map((marker, index) => {
      const body = output.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? output.length);
      return body.split(/^[ \t]*-+[ \t]*(?:Display ID:|Client Screen Infos)/m)[0];
    }) : [output];
    const real: NativeDisplayGeometry[] = [];
    const identities = new Set<string>();
    for (const record of records) {
      const sections = (name: string) => [...record.matchAll(new RegExp(`^[ \\t]*\\[${name}\\][ \\t]*\\r?\\n([\\s\\S]*?)(?=^[ \\t]*\\[|$(?![\\s\\S]))`, "gm"))];
      const sessions = sections("SCREEN SESSION"), properties = sections("SCREEN PROPERTY"), infos = sections("SCREEN INFO");
      if (sessions.length !== 1 || properties.length !== 1 || infos.length > 1 || properties[0].index! < sessions[0].index!) return undefined;
      const ids = [...sessions[0][1].matchAll(/^[ \t]*DisplayId:[ \t]*(\d+)[ \t]*\r?$/gm)];
      if (ids.length !== 1 || [...sessions[0][1].matchAll(/^[ \t]*DisplayId:/gm)].length !== 1 || identities.has(ids[0][1])) return undefined;
      identities.add(ids[0][1]);
      const types = [
        ...sessions[0][1].matchAll(/^[ \t]*ScreenType:[ \t]*(.*)$/gm),
        ...(infos[0]?.[1] ?? "").matchAll(/^[ \t]*ScreenType:[ \t]*(.*)$/gm),
        ...properties[0][1].matchAll(/^[ \t]*GetScreenType:[ \t]*(.*)$/gm),
      ].map(match => match[1].trim());
      // OpenHarmony utils/include/screen_info.h: REAL=1, VIRTUAL=2.
      // A screen name or internal flag alone does not classify an input target.
      if (types.some(type => type !== "1" && type !== "2") || new Set(types).size > 1 || (!types.length && records.length > 1)) return undefined;
      if (types[0] === "2") continue;
      const section = properties[0][1];
      const bounds = [...section.matchAll(/^[ \t]*Bounds<L,T,W,H>:[ \t]*0(?:\.0+)?,[ \t]*0(?:\.0+)?,[ \t]*(\d+)(?:\.0+)?,[ \t]*(\d+)(?:\.0+)?,?[ \t]*\r?$/gm)];
      const rotations = [...section.matchAll(/^[ \t]*ScreenRotation:[ \t]*(0|1|2|3|90|180|270)[ \t]*\r?$/gm)];
      if (bounds.length !== 1 || rotations.length !== 1
        || [...section.matchAll(/^[ \t]*Bounds<L,T,W,H>:/gm)].length !== 1
        || [...section.matchAll(/^[ \t]*ScreenRotation:/gm)].length !== 1) return undefined;
      const nativeWidth = Number(bounds[0][1]), nativeHeight = Number(bounds[0][2]), rotation = Number(rotations[0][1]);
      if (nativeWidth < 1 || nativeHeight < 1 || nativeWidth > 16_384 || nativeHeight > 16_384) return undefined;
      real.push({ nativeWidth, nativeHeight, displayId: ids[0][1], displayRotation: (rotation < 4 ? rotation * 90 : rotation) as NativeDisplayGeometry["displayRotation"] });
    }
    return real.length === 1 ? real[0] : undefined;
  }
  const rows = lines.slice(start + 1).map(line => line.match(/^\s*(\d+)\s+\d+\s+[\d.]+\s+[\d.]+\s+([0-3])\s+\d+\s+\d+\s+\d+\s+\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/)).filter(match => match !== null);
  if (rows.length !== 1) return undefined;
  const [, displayId, rotation, width, height] = rows[0];
  const nativeWidth = Number(width), nativeHeight = Number(height);
  if (nativeWidth < 1 || nativeHeight < 1 || nativeWidth > 16_384 || nativeHeight > 16_384) return undefined;
  return { nativeWidth, nativeHeight, displayId, displayRotation: (Number(rotation) * 90) as NativeDisplayGeometry["displayRotation"] };
}
