import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { HarmonyError } from "./errors";
import { assertUnredirectedPath } from "./runtime/path-safety";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const BUNDLE_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
const SIGNATURE = /^[A-Fa-f0-9]{64}$/;
type JsonObject = Record<string, unknown>;
type PrivilegeField = "singleton" | "allowAppUsePrivilegeExtension";
export interface PrivilegeChange { field: PrivilegeField; before: boolean | undefined; after: boolean }
export interface PrivilegeEdit { path: string; bundleName: string; fingerprint: string; singleton: boolean; allowAppUsePrivilegeExtension: boolean }

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }

async function readConfig(path: string): Promise<{ absolute: string; bytes: Buffer; data: JsonObject; digest: string; mode: number }> {
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute system-image configuration path");
  const absolute = resolve(path);
  if (basename(absolute) !== "install_list_capability.json" || !isExistingFilePathAllowed(absolute, await getAllowedFileRoots())) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose install_list_capability.json within an allowed workspace");
  }
  await assertUnredirectedPath(absolute);
  const details = await lstat(absolute);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_CONFIG_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular configuration file no larger than 2 MiB");
  const bytes = await readFile(absolute);
  if (bytes.length > MAX_CONFIG_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Configuration grew beyond 2 MiB");
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HarmonyError("INVALID_ARGUMENT", "Configuration is not valid UTF-8 JSON"); }
  if (!object(data) || !Array.isArray(data.install_list) || !data.install_list.every(object)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Configuration must contain an install_list array of objects");
  }
  return { absolute, bytes, data, digest: hash(bytes), mode: details.mode };
}

function patchConfig(data: JsonObject, edit: PrivilegeEdit): { data: JsonObject; changes: PrivilegeChange[] } {
  if (!BUNDLE_NAME.test(edit.bundleName) || !SIGNATURE.test(edit.fingerprint) || typeof edit.singleton !== "boolean" || typeof edit.allowAppUsePrivilegeExtension !== "boolean") {
    throw new HarmonyError("INVALID_ARGUMENT", "Provide a valid bundle name, SHA-256 certificate fingerprint and both privilege values");
  }
  const list = data.install_list as JsonObject[];
  const matches = list.filter(item => item.bundleName === edit.bundleName);
  if (matches.length > 1) throw new HarmonyError("INVALID_ARGUMENT", "Bundle appears more than once in this configuration");
  const existing = matches[0];
  if (existing && existing.app_signature !== undefined && (!Array.isArray(existing.app_signature)
    || !existing.app_signature.some(value => typeof value === "string" && value.toUpperCase() === edit.fingerprint.toUpperCase()))) {
    throw new HarmonyError("INVALID_ARGUMENT", "Existing bundle entry has a different certificate fingerprint");
  }
  const before: JsonObject = existing ?? { bundleName: edit.bundleName };
  const values: Record<PrivilegeField, boolean> = { singleton: edit.singleton, allowAppUsePrivilegeExtension: edit.allowAppUsePrivilegeExtension };
  const changes = (Object.keys(values) as PrivilegeField[]).filter(field => before[field] !== values[field])
    .map(field => ({ field, before: typeof before[field] === "boolean" ? before[field] as boolean : undefined, after: values[field] }));
  const replacement = { ...before, app_signature: [edit.fingerprint.toUpperCase()], ...values };
  const next = existing ? list.map(item => item === existing ? replacement : item) : [...list, replacement];
  return { data: { ...data, install_list: next }, changes };
}

export async function previewPrivilegeConfig(edit: PrivilegeEdit) {
  const current = await readConfig(edit.path);
  const patched = patchConfig(current.data, edit);
  const after = `${JSON.stringify(patched.data, null, 2)}\n`;
  if (Buffer.byteLength(after, "utf8") > MAX_CONFIG_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Resulting configuration exceeds 2 MiB");
  return { path: current.absolute, sourceHash: current.digest, before: current.bytes.toString("utf8"), after, changes: patched.changes };
}

async function replaceConfig(path: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.piora-privilege-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function applyPrivilegeConfig(edit: PrivilegeEdit, expectedHash: string) {
  const preview = await previewPrivilegeConfig(edit);
  if (!SIGNATURE.test(expectedHash) || preview.sourceHash !== expectedHash) throw new HarmonyError("STALE_SNAPSHOT", "Configuration changed since preview; preview it again");
  const current = await readConfig(edit.path);
  if (current.digest !== expectedHash) throw new HarmonyError("STALE_SNAPSHOT", "Configuration changed before applying the edit");
  if (!preview.changes.length) throw new HarmonyError("INVALID_ARGUMENT", "Configuration already has the requested values");
  const backupPath = join(dirname(current.absolute), `install_list_capability.json.piora-backup-${Date.now()}-${randomUUID()}`);
  await writeFile(backupPath, current.bytes, { flag: "wx", mode: 0o600 });
  const applied = Buffer.from(preview.after, "utf8");
  await replaceConfig(current.absolute, applied, current.mode);
  const verified = await readConfig(current.absolute);
  if (verified.digest !== hash(applied)) throw new HarmonyError("INVALID_RESPONSE", "Written configuration did not match the preview");
  return { path: current.absolute, backupPath, sourceHash: current.digest, appliedHash: verified.digest };
}

export async function restorePrivilegeConfig(path: string, backupPath: string, expectedHash: string) {
  const current = await readConfig(path);
  if (!SIGNATURE.test(expectedHash) || current.digest !== expectedHash) throw new HarmonyError("STALE_SNAPSHOT", "Configuration changed since it was last verified");
  if (typeof backupPath !== "string" || !/^install_list_capability\.json\.piora-backup-\d+-[0-9a-f-]{36}$/.test(basename(backupPath))
    || dirname(resolve(backupPath)) !== dirname(current.absolute) || !isExistingFilePathAllowed(backupPath, await getAllowedFileRoots())) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose a Piora backup next to this configuration");
  }
  await assertUnredirectedPath(backupPath);
  const backupStat = await lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.size > MAX_CONFIG_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Backup is not a regular configuration file");
  const bytes = await readFile(backupPath);
  let restoredData: unknown;
  try { restoredData = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HarmonyError("INVALID_ARGUMENT", "Backup is not valid UTF-8 JSON"); }
  if (!object(restoredData) || !Array.isArray(restoredData.install_list)) throw new HarmonyError("INVALID_ARGUMENT", "Backup has no install_list");
  const safetyPath = join(dirname(current.absolute), `install_list_capability.json.piora-backup-${Date.now()}-${randomUUID()}`);
  await writeFile(safetyPath, current.bytes, { flag: "wx", mode: 0o600 });
  await replaceConfig(current.absolute, bytes, current.mode);
  const verified = await readConfig(current.absolute);
  if (verified.digest !== hash(bytes)) throw new HarmonyError("INVALID_RESPONSE", "Restored configuration could not be verified");
  return { path: current.absolute, backupPath: safetyPath, restoredHash: verified.digest };
}
