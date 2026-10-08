import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { readJson, safeRelative, sourceCacheKey, sourceRoot } from "./store";
import { MAX_BYTES, MAX_FILES, skillMetadata } from "./content";
import { SkillSourceError, type SkillSource, type SkillBundle, type CatalogSkill } from "./types";

const run = promisify(execFile);
const gitOptions = { timeout: 60_000, maxBuffer: MAX_BYTES, windowsHide: true };
async function git(args: string[], cwd: string): Promise<Buffer> {
  try { const { stdout } = await run("git", ["-c", "core.hooksPath=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args], { ...gitOptions, cwd, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || "ssh"} -oBatchMode=yes -oStrictHostKeyChecking=yes` } }); return stdout; }
  catch { throw new SkillSourceError("git", "Git access failed. Check the repository, ref and non-interactive Git/SSH credentials on this machine.", 502); }
}
interface TreeFile { name: string; mode: string; sha: string }
export async function withGitSnapshot<T>(source: SkillSource, fn: (ctx: { commit: string; pinned: boolean; entries: TreeFile[]; read: (file: TreeFile) => Promise<Buffer> }) => Promise<T>, version?: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "piora-skill-git-"));
  try {
    await git(["init", "--bare", "."], dir);
    const ref = version || source.ref || "HEAD";
    if (version && !/^[0-9a-f]{40,64}$/i.test(version)) throw new SkillSourceError("version", "Invalid Git commit");
    let transport = source.url;
    try { await git(["fetch", "--depth=1", "--no-tags", "--", transport, ref], dir); }
    catch (error) {
      // Same repository, different transport; uses the user's existing SSH authentication.
      const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(source.url);
      if (!github) throw error;
      transport = `git@github.com:${github[1]}.git`;
      await git(["fetch", "--depth=1", "--no-tags", "--", transport, ref], dir);
    }
    const commit = (await git(["rev-parse", "FETCH_HEAD^{commit}"], dir)).toString().trim();
    const lines = (await git(["ls-tree", "-r", "-z", commit], dir)).toString().split("\0").filter(Boolean);
    if (lines.length > 50000) throw new SkillSourceError("size", "Repository has too many files; use a smaller repository");
    const prefix = source.subdirectory ? `${safeRelative(source.subdirectory)}/` : "";
    const entries = lines.map(line => { const [meta, ...name] = line.split("\t"); const [mode, , sha] = meta.split(" "); return { mode, sha, name: name.join("\t") }; }).filter(e => e.name.startsWith(prefix));
    let pinned = Boolean(source.ref && /^[0-9a-f]{40,64}$/i.test(source.ref));
    if (source.ref && !pinned) {
      const tag = source.ref.replace(/^refs\/tags\//, "");
      const tags = await git(["ls-remote", "--tags", "--", transport, `refs/tags/${tag}`], dir);
      pinned = tags.length > 0;
    }
    return await fn({ commit, pinned, entries, read: file => git(["cat-file", "blob", file.sha], dir) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function gitCatalog(source: SkillSource, refresh = false): Promise<CatalogSkill[]> {
  const cacheDir = join(sourceRoot(), "cache");
  const cacheFile = join(cacheDir, `git-${sourceCacheKey(source)}.json`);
  const cached = readJson<{ at: number; items: CatalogSkill[] } | null>(cacheFile, null);
  if (!refresh && cached && Date.now() - cached.at < 15 * 60_000) return cached.items.map(s => ({ ...s, sourceId: source.id }));
  const items = await withGitSnapshot(source, async ctx => {
    const skills: CatalogSkill[] = [];
    const candidates = ctx.entries.filter(e => /(^|\/)SKILL.md$/.test(e.name) && ["100644", "100755"].includes(e.mode));
    if (candidates.length > 1000) throw new SkillSourceError("size", "Too many skills; select a subdirectory");
    for (const file of candidates) {
      try {
        const data = skillMetadata(new Map([["SKILL.md", await ctx.read(file)]]));
        skills.push({ sourceId: source.id, id: file.name, name: data.name, description: data.description, version: ctx.commit, url: source.url.startsWith("https:") ? source.url.replace(/\.git$/, "") : undefined });
      } catch (error) { if (!(error instanceof SkillSourceError) || error.code !== "format") throw error; }
    }
    return skills;
  });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(cacheFile, JSON.stringify({ at: Date.now(), items }));
  return items;
}
export async function gitBundle(source: SkillSource, id: string, version?: string): Promise<SkillBundle> {
  safeRelative(id);
  if (!/(^|\/)SKILL.md$/.test(id)) throw new SkillSourceError("path", "Select a SKILL.md from the repository");
  return withGitSnapshot(source, async ctx => {
    if (!ctx.entries.some(e => e.name === id)) throw new SkillSourceError("missing", "Skill not found in repository", 404);
    const prefix = id.slice(0, -8), entries = ctx.entries.filter(e => e.name.startsWith(prefix));
    if (entries.length > MAX_FILES) throw new SkillSourceError("size", "Skill has too many files");
    const files = new Map<string, Buffer>(); let total = 0;
    for (const file of entries) {
      if (!["100644", "100755"].includes(file.mode)) throw new SkillSourceError("path", "Skill contains a link or submodule");
      const name = safeRelative(file.name.slice(prefix.length)), data = await ctx.read(file); total += data.length;
      if (total > MAX_BYTES) throw new SkillSourceError("size", "Skill exceeds 50 MB");
      files.set(name, data);
    }
    const metadata = skillMetadata(files);
    return { files, executableFiles: entries.filter(e => e.mode === "100755").map(e => e.name.slice(prefix.length)), detail: { sourceId: source.id, id, ...metadata, version: ctx.commit, pinned: ctx.pinned, files: [...files.keys()], url: source.url.startsWith("https:") ? source.url.replace(/\.git$/, "") : undefined } };
  }, version);
}
