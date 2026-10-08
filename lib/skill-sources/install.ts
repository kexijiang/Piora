import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope, SkillUpdateResult } from "../api-types";
import { getRuntimeAgentDataDirectory, getRuntimeHomeDirectory } from "../runtime-home";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { contentHash, MAX_BYTES, MAX_FILES, skillMetadata, withoutToggle } from "./content";
import { fetchBundle } from "./adapters";
import { getSource, listSources, readJson, safeRelative, sourceIdentity, withStoreLock } from "./store";
import { SkillSourceError, type SkillBundle } from "./types";

export interface ManagedInstall {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceIdentity: string;
  skillId: string;
  name: string;
  scope: SkillInstallScope;
  version: string;
  hash: string;
  pinned: boolean;
  url?: string;
  installedAt: string;
}
function locations(scope: SkillInstallScope, cwd?: string) {
  if (scope !== "global" && scope !== "project") throw new SkillSourceError("scope", "Invalid install scope");
  if (scope === "project" && !cwd) throw new SkillSourceError("cwd", "Project directory is required");
  const base = scope === "global" ? getRuntimeAgentDataDirectory() : join(cwd!, ".pi");
  return { base, skills: join(base, "skills"), data: join(base, "piora", "skill-installs"), record: join(base, "piora", "skill-installs", "installs.json") };
}
function assertDirectoryChain(path: string) {
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new SkillSourceError("path", "Managed skill paths cannot traverse a symbolic link");
    const parent = dirname(cursor); if (cursor === parent) break; cursor = parent;
  }
}
function records(scope: SkillInstallScope, cwd?: string): ManagedInstall[] { return readJson(locations(scope, cwd).record, []); }
function targetPath(record: ManagedInstall, cwd?: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name)) throw new SkillSourceError("storage", "Invalid installed skill name", 500);
  return join(locations(record.scope, cwd).skills, record.name);
}
export function readLocalFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>(); let bytes = 0;
  function visit(dir: string) {
    if (lstatSync(dir).isSymbolicLink()) throw new SkillSourceError("modified", "Local skill contains links", 409);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new SkillSourceError("modified", "Local skill contains links", 409);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        bytes += lstatSync(full).size;
        if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new SkillSourceError("size", "Local skill is too large");
        files.set(relative(root, full).split(sep).join("/"), readFileSync(full));
      } else throw new SkillSourceError("modified", "Unexpected local file type", 409);
    }
  }
  visit(root); return files;
}
export function managedInstallInfo(record: ManagedInstall): SkillInstallInfo {
  const source = listSources().find(s => s.id === record.sourceId);
  return { package: `piora:${record.id}`, scope: record.scope, source: record.sourceName, sourceId: record.sourceId, skillId: record.skillId,
    installId: record.id, sourceUrl: record.url, sourceType: "piora", versionHash: record.version, pinned: record.pinned,
    canCheckForUpdates: Boolean(source?.enabled && sourceIdentity(source) === record.sourceIdentity && !record.pinned) };
}
export function annotateManagedSkills(skills: SkillInfo[], cwd?: string): SkillInfo[] {
  const all = [...records("global"), ...(cwd ? records("project", cwd) : [])];
  return skills.map(skill => {
    const match = all.find(record => resolve(join(targetPath(record, cwd), "SKILL.md")) === resolve(skill.filePath));
    return match ? { ...skill, install: managedInstallInfo(match) } : skill;
  });
}
export function findManagedInstall(id: string, scope: SkillInstallScope, cwd?: string) {
  const found = records(scope, cwd).find(r => r.id === id);
  if (!found) throw new SkillSourceError("missing", "Installed skill not found", 404);
  return found;
}
export async function checkManagedUpdate(install: SkillInstallInfo, cwd?: string): Promise<SkillUpdateResult> {
  const result: SkillUpdateResult = { package: install.package, scope: install.scope, state: "unsupported", currentVersion: install.versionHash };
  try {
    const record = findManagedInstall(install.installId!, install.scope, cwd);
    if (record.pinned) return { ...result, message: "Version is pinned" };
    const source = getSource(record.sourceId);
    if (sourceIdentity(source) !== record.sourceIdentity) throw new SkillSourceError("changed", "The original source is unavailable", 409);
    const bundle = await fetchBundle(source, record.skillId);
    return { ...result, state: contentHash(bundle.files) === record.hash ? "up-to-date" : "update-available", latestVersion: bundle.detail.version };
  } catch (error) { return { ...result, state: "error", message: error instanceof SkillSourceError ? error.message : "Update check failed" }; }
}

export async function installRemoteSkill(options: { sourceId: string; skillId: string; scope: SkillInstallScope; cwd?: string; version?: string; updateId?: string }, acquire = fetchBundle): Promise<SkillInstallInfo> {
  const source = getSource(options.sourceId);
  const bundle = await acquire(source, options.skillId, options.version);
  return commitSkillBundle(options, bundle);
}

// Kept separate from transport so failures and races can be exercised against isolated directories.
export async function commitSkillBundle(options: { sourceId: string; skillId: string; scope: SkillInstallScope; cwd?: string; updateId?: string }, bundle: SkillBundle, writeRecord = writePrivateFileAtomicSync): Promise<SkillInstallInfo> {
  const source = getSource(options.sourceId);
  const { name } = skillMetadata(bundle.files);
  if (!bundle.detail.version) throw new SkillSourceError("version", "Skill version was not resolved");
  const resolvedVersion = bundle.detail.version;
  const paths = locations(options.scope, options.cwd);
  assertDirectoryChain(paths.data); assertDirectoryChain(paths.skills);
  return withStoreLock(paths.data, async () => {
    const all = records(options.scope, options.cwd);
    const previous = options.updateId ? findManagedInstall(options.updateId, options.scope, options.cwd) : undefined;
    if (previous && (previous.pinned || previous.name !== name || previous.sourceId !== source.id || previous.skillId !== options.skillId || previous.sourceIdentity !== sourceIdentity(source))) throw new SkillSourceError("changed", "Installed skill identity or version pin prevents this update", 409);
    const target = join(paths.skills, name);
    assertDirectoryChain(target);
    if (existsSync(target) && !previous) {
      const existing = all.find(record => record.name.toLowerCase() === name.toLowerCase());
      throw new SkillSourceError("conflict", `A skill already exists at ${target}${existing ? ` (source: ${existing.sourceName})` : ""}`, 409);
    }
    // Include manually installed SDK skills with the same name in this scope.
    if (!previous) {
      const shared = join(options.scope === "global" ? getRuntimeHomeDirectory() : options.cwd!, ".agents", "skills");
      const candidates = [paths.skills, shared].flatMap(dir => loadSkillsFromDir({ dir, source: options.scope === "global" ? "user" : "project" }).skills);
      const conflict = candidates.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (conflict) throw new SkillSourceError("conflict", `A skill with this name already exists at ${conflict.filePath}`, 409);
    }
    const hash = contentHash(bundle.files), files = new Map(bundle.files);
    if (previous) {
      if (!existsSync(target)) throw new SkillSourceError("modified", "Installed files are missing", 409);
      const local = readLocalFiles(target);
      if (contentHash(local) !== previous.hash) throw new SkillSourceError("modified", "Local skill files were edited; keep or remove those changes before updating", 409);
      const disabled = Boolean(parseFrontmatter<Record<string, unknown>>(local.get("SKILL.md")!.toString("utf8")).frontmatter["disable-model-invocation"]);
      let readme = withoutToggle(files.get("SKILL.md")!.toString("utf8"));
      if (disabled) readme = readme.replace(/^---\n/, "---\ndisable-model-invocation: true\n");
      files.set("SKILL.md", Buffer.from(readme));
    }
    const stage = join(paths.data, `stage-${randomUUID()}`), backup = join(paths.data, `backup-${randomUUID()}`);
    let movedOld = false, movedNew = false;
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const record: ManagedInstall = { id: previous?.id || randomUUID(), sourceId: source.id, sourceName: source.name, sourceIdentity: sourceIdentity(source), skillId: options.skillId, name, scope: options.scope, version: resolvedVersion, hash, pinned: Boolean(bundle.detail.pinned), url: bundle.detail.url, installedAt: new Date().toISOString() };
    try {
      for (const [name, bytes] of files) { const file = join(stage, safeRelative(name)); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: "wx", mode: bundle.executableFiles?.includes(name) || bytes.subarray(0, 2).toString() === "#!" ? 0o700 : 0o600 }); }
      mkdirSync(paths.skills, { recursive: true });
      if (previous) { renameSync(target, backup); movedOld = true; }
      renameSync(stage, target); movedNew = true;
      writeRecord(paths.record, JSON.stringify([...all.filter(r => r.id !== record.id), record]));
    } catch (error) {
      if (movedNew) rmSync(target, { recursive: true, force: true });
      if (movedOld) renameSync(backup, target);
      throw error;
    } finally { rmSync(stage, { recursive: true, force: true }); }
    // A cleanup failure must not report the committed installation as failed.
    if (movedOld) { try { rmSync(backup, { recursive: true, force: true }); } catch { /* recoverable backup */ } }
    return managedInstallInfo(record);
  });
}
