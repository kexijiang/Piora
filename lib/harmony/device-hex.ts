import { createHash } from "node:crypto";

export const MAX_DEVICE_HEX_FILE_BYTES = 64 * 1024;
export const DEVICE_HEX_VISIBLE_BYTES = 512;

/** A bounded, text-only view of the beginning of a captured regular file. */
export function deviceHexPreview(bytes: Buffer) {
  const visible = bytes.subarray(0, DEVICE_HEX_VISIBLE_BYTES);
  const lines: string[] = [];
  for (let offset = 0; offset < visible.length; offset += 16) {
    const row = visible.subarray(offset, offset + 16);
    const hex = [...row].map(byte => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = [...row].map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return { size: bytes.length, shown: visible.length, truncated: bytes.length > visible.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), text: lines.join("\n") };
}
