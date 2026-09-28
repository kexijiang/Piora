import { posix } from "node:path";
import { HarmonyError } from "./errors";

export type HarmonyFileScope = { kind: "shared" } | { kind: "sandbox"; bundleName: string };
export interface HarmonyDeviceFile {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt?: number;
  mode?: string;
}

const bundlePattern = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;

export function validateDeviceFilePath(scope: HarmonyFileScope, value: string): string {
  if (scope.kind === "sandbox" && !bundlePattern.test(scope.bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid sandbox bundle name");
  if (typeof value !== "string" || value.length > 4096 || /[\0-\x1f\x7f]/.test(value) || value.includes("\\")) {
    throw new HarmonyError("INVALID_ARGUMENT", "Invalid device file path");
  }
  const components = value.split("/");
  if (components.includes("..")) throw new HarmonyError("INVALID_ARGUMENT", "Device path traversal is unavailable");
  if (scope.kind === "shared") {
    if (!value.startsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Shared device paths must be absolute");
    return posix.normalize(value);
  }
  if (value.startsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Sandbox paths must be relative to the debug app");
  const normalized = posix.normalize(value || ".");
  if (normalized !== "." && !normalized.startsWith("data/storage/")) {
    throw new HarmonyError("INVALID_ARGUMENT", "Sandbox browsing is limited to data/storage");
  }
  return normalized;
}

export function validateWritableDeviceFilePath(scope: HarmonyFileScope, value: string): string {
  const normalized = validateDeviceFilePath(scope, value);
  if (scope.kind === "sandbox") {
    if (!normalized.startsWith("data/storage/") || normalized.endsWith("/")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a file within the debug app storage");
    }
  } else if (!normalized.startsWith("/data/local/tmp/") && !normalized.startsWith("/sdcard/")
    && !normalized.startsWith("/storage/") && !/^\/mnt\/data\/\d+\/media_fuse\//.test(normalized)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Device writes are limited to temporary or shared media paths");
  }
  if (normalized.endsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Choose a file, not a directory");
  return normalized;
}

export function quoteDeviceShell(value: string): string {
  if (/[\0-\x1f\x7f]/.test(value)) throw new HarmonyError("INVALID_ARGUMENT", "Control characters are unavailable in shell paths");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** NUL records keep whitespace and Unicode file names intact. */
export function parseDeviceFileListing(output: Buffer, parent: string): { files: HarmonyDeviceFile[]; truncated: boolean } {
  const fields = output.toString("utf8").split("\0");
  const marker = fields.findIndex(value => ["__PIORA_DIR_OK__", "__PIORA_DIR_ERROR__", "__PIORA_STAT_ERROR__"].includes(value));
  if (marker < 0) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The device did not return a file listing");
  if (fields[marker] === "__PIORA_DIR_ERROR__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device directory is missing or inaccessible");
  if (fields[marker] === "__PIORA_STAT_ERROR__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device stat is unavailable for file browsing");
  const files: HarmonyDeviceFile[] = [];
  let truncated = false;
  for (let index = marker + 1; index + 4 < fields.length; index += 5) {
    if (fields[index] === "__PIORA_TRUNCATED__") { truncated = true; break; }
    const [path, kindText, sizeText, modifiedText, mode] = fields.slice(index, index + 5);
    if (!path || !path.startsWith(parent === "." ? "" : parent === "/" ? "/" : `${parent}/`)) continue;
    const name = posix.basename(path);
    if (!name || name === "." || name === ".." || /[\0-\x1f\x7f]/.test(name)) continue;
    const kind = kindText === "directory" ? "directory" : kindText === "regular file" ? "file" : kindText.includes("symbolic link") ? "symlink" : "other";
    const size = /^\d+$/.test(sizeText) ? Number(sizeText) : undefined;
    const modifiedAt = /^\d+$/.test(modifiedText) ? Number(modifiedText) * 1000 : undefined;
    files.push({ path, name, kind, size: Number.isSafeInteger(size) ? size : undefined,
      modifiedAt: Number.isSafeInteger(modifiedAt) ? modifiedAt : undefined,
      mode: /^[0-7]{3,4}$/.test(mode) ? mode : undefined });
  }
  return { files: files.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1).slice(0, 500), truncated };
}

export function deviceFileListScript(path: string): string {
  const quoted = quoteDeviceShell(path);
  return `d=${quoted}; if [ ! -d "$d" ] || [ ! -r "$d" ] || [ ! -x "$d" ]; then printf '__PIORA_DIR_ERROR__\\0'; exit 0; fi; if ! stat -c '%F' "$d" >/dev/null 2>&1; then printf '__PIORA_STAT_ERROR__\\0'; exit 0; fi; printf '__PIORA_DIR_OK__\\0'; n=0; for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ "$n" -ge 500 ]; then printf '__PIORA_TRUNCATED__\\0\\0\\0\\0\\0'; break; fi; k=$(stat -c '%F' "$f" 2>/dev/null) || continue; s=$(stat -c '%s' "$f" 2>/dev/null) || continue; t=$(stat -c '%Y' "$f" 2>/dev/null) || continue; m=$(stat -c '%a' "$f" 2>/dev/null) || continue; printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "$f" "$k" "$s" "$t" "$m"; n=$((n+1)); done`;
}
