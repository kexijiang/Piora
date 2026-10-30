import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { assertUiAction, UI_ACTION_LIMITS, UiActionError, validateActionPath, type UiAction } from "./action-contract";
import { formatSnapshot, validateState, validateSurface, type UiState, type UiSurface } from "./surface-document";
import { parseUiPlanPrefix } from "./preview-parser";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => {
  const rel = relative(root, path); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
export interface UiActionFileEvidence {
  root: string; path: string; exists: boolean;
  rootIdentity: { device: number; inode: number }; parentIdentity: { device: number; inode: number };
  identity?: { device: number; inode: number; size: number; modified: number; changed: number };
  sha256?: string;
}
/** No directory creation, symlink traversal, sensitive path aliases or URLs. */
export function resolveActionFile(cwd: string, declaredPath: string): { root: string; path: string } {
  const safe = validateActionPath(declaredPath), root = realpathSync(cwd), path = resolve(root, safe);
  assertUiAction(lstatSync(root).isDirectory() && inside(root, path), "TARGET", "Action target must be a file inside the current project");
  let current = root;
  const segments = safe.split("/");
  segments.forEach((segment, index) => {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      // lstat still detects dangling symbolic links, which existsSync hides.
      let missing = false;
      try { lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true; else throw error; }
      assertUiAction(missing && index === segments.length - 1, "TARGET", "Target parent must already exist and must not be a symbolic link");
      return;
    }
    const stat = lstatSync(current);
    assertUiAction(!stat.isSymbolicLink() && (index === segments.length - 1 ? stat.isFile() : stat.isDirectory()), "TARGET", "Action paths must contain only real directories and regular files");
    assertUiAction(inside(root, realpathSync(current)), "TARGET", "Action target left the project");
  });
  return { root, path };
}
function identity(stat: ReturnType<typeof fstatSync>): NonNullable<UiActionFileEvidence["identity"]> {
  return { device: Number(stat.dev), inode: Number(stat.ino), size: Number(stat.size), modified: Number(stat.mtimeMs), changed: Number(stat.ctimeMs) };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const directoryIdentity = (path: string) => { const stat = lstatSync(path); return { device: stat.dev, inode: stat.ino }; };
function readStable(cwd: string, declaredPath: string): { evidence: UiActionFileEvidence; bytes?: Buffer } {
  const target = resolveActionFile(cwd, declaredPath);
  const directories = { rootIdentity: directoryIdentity(target.root), parentIdentity: directoryIdentity(dirname(target.path)) };
  if (!existsSync(target.path)) return { evidence: { ...target, ...directories, exists: false } };
  const fd = openSync(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd), metadata = identity(before);
    assertUiAction(before.isFile() && before.nlink === 1, "TARGET", "Linked or non-regular files are not supported");
    assertUiAction(before.size <= UI_ACTION_LIMITS.fileBytes, "LIMIT", "Action file exceeds the byte budget");
    assertUiAction(same(resolveActionFile(cwd, declaredPath), target) && same(identity(lstatSync(target.path)), metadata), "CONFLICT", "File identity changed during inspection");
    const bytes = Buffer.alloc(UI_ACTION_LIMITS.fileBytes + 1); let count = 0, read = 0;
    do { read = readSync(fd, bytes, count, bytes.length - count, count); count += read; } while (read && count < bytes.length);
    assertUiAction(count <= UI_ACTION_LIMITS.fileBytes, "LIMIT", "Action file grew beyond its byte budget");
    assertUiAction(same(identity(fstatSync(fd)), metadata) && same(identity(lstatSync(target.path)), metadata)
      && same(resolveActionFile(cwd, declaredPath), target), "CONFLICT", "File changed while it was read");
    const result = bytes.subarray(0, count);
    return { evidence: { ...target, ...directories, exists: true, identity: metadata, sha256: hash(result) }, bytes: result };
  } finally { closeSync(fd); }
}
export function inspectActionFile(cwd: string, action: UiAction): UiActionFileEvidence {
  return readStable(cwd, action.path).evidence;
}

/** The query returns proposed values. Applying them still requires the normal state CAS. */
export function readActionParameters(cwd: string, action: Extract<UiAction, { kind: "read_json_parameters" }>,
  surface: UiSurface, expected: UiActionFileEvidence): { state: UiState; evidence: UiActionFileEvidence } {
  const result = readStable(cwd, action.path);
  assertUiAction(result.bytes && same(result.evidence, expected), "CONFLICT", "Parameter file is missing or changed after review");
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    const decoded = parseUiPlanPrefix(text);
    assertUiAction(decoded.status === "complete", "INVALID", "Parameter JSON must be complete, bounded and contain no duplicate keys");
    parsed = decoded.values;
  } catch { throw new UiActionError("INVALID", "Parameter file must contain valid UTF-8 JSON", "parameters_invalid"); }
  try { return { state: validateState(validateSurface(surface), parsed), evidence: result.evidence }; }
  catch { throw new UiActionError("INVALID", "JSON must contain exactly the current input IDs and valid values", "parameters_invalid"); }
}

/** All report content is derived from a validated committed snapshot by the host. */
export function actionSnapshotBytes(action: Extract<UiAction, { kind: "save_snapshot" }>, surface: UiSurface, state: UiState): Buffer {
  const validated = validateSurface(surface), parameters = validateState(validated, state), snapshot = formatSnapshot(validated, parameters);
  assertUiAction(snapshot.length <= UI_ACTION_LIMITS.resultCharacters, "LIMIT", "Snapshot exceeds the action result budget");
  // Markdown is plain quoted text: the report must not turn model HTML into executable markup.
  const text = action.format === "json" ? JSON.stringify({ version: 1, surfaceId: validated.id, surfaceRevision: validated.revision, title: validated.title, parameters, snapshot }, null, 2) + "\n"
    : snapshot.split(/\r\n?|\n/).map(line => `    ${line}`).join("\n") + "\n";
  const bytes = Buffer.from(text, "utf8");
  assertUiAction(bytes.length <= UI_ACTION_LIMITS.fileBytes, "LIMIT", "Encoded report exceeds the file byte budget");
  return bytes;
}
/** Create once. A pre-existing file is never overwritten, including identical content. */
export function createActionSnapshot(cwd: string, action: Extract<UiAction, { kind: "save_snapshot" }>,
  bytes: Buffer, expected: UiActionFileEvidence, assertAuthorized: () => void): { path: string; sha256: string; bytes: number } {
  assertUiAction(Buffer.isBuffer(bytes) && bytes.length <= UI_ACTION_LIMITS.fileBytes, "LIMIT", "Report bytes exceed the action budget");
  const current = inspectActionFile(cwd, action);
  assertUiAction(!expected.exists && same(current, expected), "CONFLICT", "Report target already exists or changed after review");
  assertAuthorized();
  let fd: number;
  try { fd = openSync(current.path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UiActionError("CONFLICT", "Report target already exists", "file_exists"); throw error; }
  try {
    const stat = fstatSync(fd);
    assertUiAction(stat.isFile() && stat.nlink === 1 && same(resolveActionFile(cwd, action.path), { root: current.root, path: current.path })
      && same(identity(lstatSync(current.path)), identity(stat)), "UNCERTAIN", "Report target moved before writing; inspect the target before retrying");
    assertAuthorized(); writeFileSync(fd, bytes); fsyncSync(fd);
  } catch (error) {
    // A file may exist already. Never delete or overwrite it to make a retry look clean.
    throw new UiActionError("UNCERTAIN", error instanceof UiActionError ? error.message : "Report write did not finish; inspect its target before retrying");
  } finally { closeSync(fd); }
  const written = inspectActionFile(cwd, action);
  assertUiAction(written.sha256 === hash(bytes), "UNCERTAIN", "Report contents changed after writing");
  return { path: written.path, sha256: written.sha256, bytes: bytes.length };
}
/** A recovered operation verifies the effect; it never replays an unknown write. */
export function reconcileActionSnapshot(cwd: string, action: Extract<UiAction, { kind: "save_snapshot" }>, expectedHash: string): "matching" | "missing" | "different" {
  const current = inspectActionFile(cwd, action);
  return !current.exists ? "missing" : current.sha256 === expectedHash ? "matching" : "different";
}
