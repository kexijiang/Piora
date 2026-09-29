import iconv from "iconv-lite";
import { HarmonyError } from "./errors";

export const MAX_DEVICE_TEXT_BYTES = 2 * 1024 * 1024;
export type DeviceNewline = "lf" | "crlf" | "cr" | "mixed" | "none";
export type WritableDeviceNewline = "lf" | "crlf" | "cr";
export type DeviceTextReadEncoding = "auto" | "utf-8" | "utf-16le" | "utf-16be" | "gb18030";
export type DeviceTextEncoding = Exclude<DeviceTextReadEncoding, "auto"> | "utf-8-bom" | "utf-16le-bom" | "utf-16be-bom";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function decodeStrict(bytes: Buffer, encoding: "utf-8" | "utf-16le" | "utf-16be"): string {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new HarmonyError("INVALID_ARGUMENT", `Device file is not valid ${encoding.toUpperCase()} text`); }
}

export function decodeDeviceText(bytes: Buffer, requested: DeviceTextReadEncoding = "auto"): { text: string; encoding: DeviceTextEncoding; newline: DeviceNewline } {
  if (bytes.length > MAX_DEVICE_TEXT_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Device text is limited to 2 MiB");
  if (!["auto", "utf-8", "utf-16le", "utf-16be", "gb18030"].includes(requested)) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported device text encoding");
  const encoding: DeviceTextEncoding = requested === "auto"
    ? bytes.subarray(0, 3).equals(UTF8_BOM) ? "utf-8-bom"
      : bytes.subarray(0, 2).equals(UTF16LE_BOM) ? "utf-16le-bom"
        : bytes.subarray(0, 2).equals(UTF16BE_BOM) ? "utf-16be-bom" : "utf-8"
    : requested === "utf-8" && bytes.subarray(0, 3).equals(UTF8_BOM) ? "utf-8-bom"
      : requested === "utf-16le" && bytes.subarray(0, 2).equals(UTF16LE_BOM) ? "utf-16le-bom"
        : requested === "utf-16be" && bytes.subarray(0, 2).equals(UTF16BE_BOM) ? "utf-16be-bom" : requested;
  const raw = encoding === "utf-8-bom" ? bytes.subarray(3)
    : encoding === "utf-16le-bom" || encoding === "utf-16be-bom" ? bytes.subarray(2) : bytes;
  const codec = encoding.replace("-bom", "") as DeviceTextReadEncoding;
  let text: string;
  if (codec === "gb18030") {
    text = iconv.decode(raw, "gb18030");
    if (!iconv.encode(text, "gb18030").equals(raw)) throw new HarmonyError("INVALID_ARGUMENT", "GB18030 file does not round-trip without loss");
  } else {
    if (codec.startsWith("utf-16") && raw.length % 2) throw new HarmonyError("INVALID_ARGUMENT", "UTF-16 file has an incomplete code unit");
    text = decodeStrict(raw, codec as "utf-8" | "utf-16le" | "utf-16be");
  }
  if (text.includes("\0")) throw new HarmonyError("INVALID_ARGUMENT", "Device text must not contain NUL characters");
  const breaks = text.match(/\r\n|\r|\n/g) ?? [];
  const kinds = new Set(breaks.map(value => value === "\r\n" ? "crlf" : value === "\r" ? "cr" : "lf"));
  const newline = kinds.size > 1 ? "mixed" : kinds.size === 0 ? "none" : [...kinds][0] as DeviceNewline;
  return { text, encoding, newline };
}

export function encodeDeviceText(text: string, encoding: DeviceTextEncoding, originalNewline: DeviceNewline, selectedNewline?: WritableDeviceNewline): Buffer {
  if (typeof text !== "string" || text.includes("\0")) throw new HarmonyError("INVALID_ARGUMENT", "Device text must not contain NUL characters");
  if (selectedNewline !== undefined && !["lf", "crlf", "cr"].includes(selectedNewline)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid newline mode");
  if (originalNewline === "mixed" && !selectedNewline) throw new HarmonyError("INVALID_ARGUMENT", "Mixed line endings require an explicit newline choice");
  const mode = selectedNewline ?? (originalNewline === "none" ? "lf" : originalNewline);
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const content = mode === "crlf" ? normalized.replaceAll("\n", "\r\n") : mode === "cr" ? normalized.replaceAll("\n", "\r") : normalized;
  const codec = encoding.replace("-bom", "") as DeviceTextReadEncoding;
  if (!["utf-8", "utf-16le", "utf-16be", "gb18030"].includes(codec)) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported device text encoding");
  const encoded = codec === "gb18030" ? iconv.encode(content, "gb18030") : codec === "utf-8" ? Buffer.from(content, "utf8") : iconv.encode(content, codec);
  if (codec === "gb18030" && iconv.decode(encoded, "gb18030") !== content) throw new HarmonyError("INVALID_ARGUMENT", "Text cannot be encoded in GB18030 without loss");
  const bom = encoding === "utf-8-bom" ? UTF8_BOM : encoding === "utf-16le-bom" ? UTF16LE_BOM : encoding === "utf-16be-bom" ? UTF16BE_BOM : undefined;
  const output = bom ? Buffer.concat([bom, encoded]) : encoded;
  if (output.length > MAX_DEVICE_TEXT_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Device text editing is limited to 2 MiB");
  return output;
}
