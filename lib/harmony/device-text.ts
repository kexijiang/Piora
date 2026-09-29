import { HarmonyError } from "./errors";

export const MAX_DEVICE_TEXT_BYTES = 2 * 1024 * 1024;
export type DeviceNewline = "lf" | "crlf" | "cr" | "mixed" | "none";
export type WritableDeviceNewline = "lf" | "crlf" | "cr";

export function decodeDeviceText(bytes: Buffer): { text: string; encoding: "utf-8" | "utf-8-bom"; newline: DeviceNewline } {
  if (bytes.length > MAX_DEVICE_TEXT_BYTES || bytes.includes(0)) throw new HarmonyError("INVALID_ARGUMENT", "Device text must be at most 2 MiB and contain no NUL bytes");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new HarmonyError("INVALID_ARGUMENT", "Device file is not UTF-8 text"); }
  const encoding = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "utf-8-bom" : "utf-8";
  const breaks = text.match(/\r\n|\r|\n/g) ?? [];
  const kinds = new Set(breaks.map(value => value === "\r\n" ? "crlf" : value === "\r" ? "cr" : "lf"));
  const newline = kinds.size > 1 ? "mixed" : kinds.size === 0 ? "none" : [...kinds][0] as DeviceNewline;
  return { text, encoding, newline };
}

export function encodeDeviceText(text: string, encoding: "utf-8" | "utf-8-bom", originalNewline: DeviceNewline, selectedNewline?: WritableDeviceNewline): Buffer {
  if (typeof text !== "string" || text.includes("\0")) throw new HarmonyError("INVALID_ARGUMENT", "Device text must not contain NUL bytes");
  if (selectedNewline !== undefined && !["lf", "crlf", "cr"].includes(selectedNewline)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid newline mode");
  if (originalNewline === "mixed" && !selectedNewline) throw new HarmonyError("INVALID_ARGUMENT", "Mixed line endings require an explicit newline choice");
  const mode = selectedNewline ?? (originalNewline === "none" ? "lf" : originalNewline);
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const content = mode === "crlf" ? normalized.replaceAll("\n", "\r\n") : mode === "cr" ? normalized.replaceAll("\n", "\r") : normalized;
  const bytes = Buffer.from(content, "utf8");
  const output = encoding === "utf-8-bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
  if (output.length > MAX_DEVICE_TEXT_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Device text editing is limited to 2 MiB");
  return output;
}
