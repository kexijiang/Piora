import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getRuntimeAgentDataDirectory } from "../runtime-home";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { SkillSourceError, type SkillSource, type SourceInput } from "./types";

export const BUILTIN_SOURCES: SkillSource[] = [
  { id: "skills-sh", name: "skills.sh", kind: "skills-sh", url: "https://skills.sh", enabled: true, builtin: true },
  { id: "skillhub", name: "腾讯 SkillHub", kind: "skillhub", url: "https://api.skillhub.cn", enabled: false, builtin: true },
  { id: "clawhub", name: "ClawHub", kind: "clawhub", url: "https://clawhub.ai", enabled: true, builtin: true },
  { id: "anthropic-skills", name: "Anthropic Skills", kind: "git", url: "https://github.com/anthropics/skills.git", subdirectory: "skills", enabled: true, builtin: true },
  { id: "vercel-skills", name: "Vercel Agent Skills", kind: "git", url: "https://github.com/vercel-labs/agent-skills.git", subdirectory: "skills", enabled: true, builtin: true },
];
export function sourceRoot() { return join(getRuntimeAgentDataDirectory(), "piora", "skill-sources"); }
export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw new SkillSourceError("storage", "Skill source storage could not be read", 500); }
}
export async function withStoreLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(root, { realpath: false, retries: { retries: 40, minTimeout: 100, maxTimeout: 250 }, stale: 120_000 });
  try { return await fn(); } finally { await release(); }
}
function records(): SkillSource[] { return readJson<SkillSource[]>(join(sourceRoot(), "sources.json"), []); }
function secrets(): Record<string, string> { return readJson(join(sourceRoot(), "credentials.json"), {}); }
export function sourceCredential(id: string): string | undefined { return secrets()[id]; }
export function sourceIdentity(s: Pick<SkillSource, "kind" | "url" | "ref" | "subdirectory">) {
  return JSON.stringify([s.kind, s.url, s.ref || "", s.subdirectory || ""]);
}
export function sourceCacheKey(source: SkillSource) {
  return createHash("sha256").update(sourceIdentity(source)).update(sourceCredential(source.id) || "").digest("hex");
}
export function listSources(): SkillSource[] {
  const saved = records(), credentials = secrets();
  return [...BUILTIN_SOURCES.map(s => saved.find(r => r.id === s.id) || s), ...saved.filter(s => !BUILTIN_SOURCES.some(b => b.id === s.id))].map(s => {
    const hasCredential = Boolean(credentials[s.id]);
    const status = readJson<{ at?: string; state?: SkillSource["state"] }>(join(sourceRoot(), `${s.id}.status.json`), {});
    return { ...s, hasCredential, state: s.id === "skillhub" && !hasCredential ? "auth-required" : !s.enabled ? "disabled" : status.state,
      lastRefreshedAt: status.at, capabilities: { search: true, browse: s.id !== "skills-sh" || hasCredential } };
  });
}
export function getSource(id: string, requireEnabled = true): SkillSource {
  const source = listSources().find(s => s.id === id);
  if (!source) throw new SkillSourceError("missing-source", "Skill source no longer exists", 404);
  if (requireEnabled && !source.enabled) throw new SkillSourceError("disabled", "Skill source is disabled", 409);
  if (requireEnabled && source.id === "skillhub" && !source.hasCredential) throw new SkillSourceError("auth-required", "Configure the SkillHub API key first", 401);
  return source;
}
export function safeRelative(value: string): string {
  if (!value || value.length > 1024 || /[\\\x00-\x1f:*?"<>|]/.test(value) || value.startsWith("/")) throw new SkillSourceError("path", "Invalid relative skill path");
  const parts = value.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || p.toLowerCase() === ".git")) throw new SkillSourceError("path", "Unsafe skill path");
  return value;
}
export function normalizeInput(input: SourceInput): SourceInput {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw new SkillSourceError("invalid", "Source name is required (maximum 120 characters)");
  if (!["git", "skills-sh", "skillhub", "clawhub"].includes(input.kind)) throw new SkillSourceError("invalid", "Unsupported source protocol");
  if (typeof input.url !== "string" || /[\s\x00-\x1f]/.test(input.url) || input.url.length > 2048) throw new SkillSourceError("invalid", "Invalid source URL");
  if ((input.ref !== undefined && typeof input.ref !== "string") || (input.subdirectory !== undefined && typeof input.subdirectory !== "string") || (input.enabled !== undefined && typeof input.enabled !== "boolean")) throw new SkillSourceError("invalid", "Invalid source options");
  let address = input.url.replace(/\/+$/, "");
  if (input.kind === "git" && /^[\w.-]+\/[\w.-]+$/.test(address)) address = `https://github.com/${address}.git`;
  const scp = input.kind === "git" && /^git@[a-z0-9.-]+:[\w./-]+$/i.test(address);
  if (!scp) {
    let url: URL;
    try { url = new URL(address); } catch { throw new SkillSourceError("invalid", "Use an HTTPS or SSH repository URL, or an HTTP(S) market URL"); }
    const protocols = input.kind === "git" ? ["https:", "ssh:"] : ["http:", "https:"];
    if (!protocols.includes(url.protocol) || url.password || (url.username && url.protocol !== "ssh:") || url.search || url.hash) throw new SkillSourceError("invalid", "Unsupported URL or embedded credentials");
    address = url.toString().replace(/\/+$/, "");
  }
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (ref && (ref.startsWith("-") || /[\s\x00-\x1f~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.length > 256)) throw new SkillSourceError("invalid", "Invalid Git ref");
  const subdirectory = input.subdirectory?.trim().replace(/\/$/, "") || "";
  if (subdirectory) safeRelative(subdirectory);
  if (input.credential !== undefined && (typeof input.credential !== "string" || input.credential.length > 8192 || /[\r\n\0]/.test(input.credential))) throw new SkillSourceError("invalid", "Invalid credential");
  return { name: input.name.trim(), kind: input.kind, url: address, enabled: input.enabled !== false,
    ...(input.kind === "git" && ref ? { ref } : {}), ...(input.kind === "git" && subdirectory ? { subdirectory } : {}),
    credential: input.credential?.trim(), clearCredential: input.clearCredential === true };
}
export async function saveSource(input: SourceInput, id?: string): Promise<SkillSource> {
  const clean = normalizeInput(input);
  return withStoreLock(sourceRoot(), async () => {
    const all = listSources(), previous = id ? getSource(id, false) : undefined;
    if (previous?.builtin && sourceIdentity(previous) !== sourceIdentity(clean)) throw new SkillSourceError("builtin", "Create a custom source to use a different endpoint");
    if (all.some(s => s.id !== id && sourceIdentity(s) === sourceIdentity(clean))) throw new SkillSourceError("duplicate", "This skill source already exists", 409);
    const changed = previous && sourceIdentity(previous) !== sourceIdentity(clean);
    const nextId = !previous || changed ? randomUUID() : previous.id;
    const source: SkillSource = { id: nextId, name: clean.name, kind: clean.kind, url: clean.url, ref: clean.ref, subdirectory: clean.subdirectory, enabled: clean.enabled !== false, builtin: previous?.builtin };
    const saved = records().filter(s => s.id !== id), credentials = secrets();
    // Never carry a credential to a changed endpoint.
    if (id && changed) delete credentials[id];
    if (clean.clearCredential) delete credentials[nextId];
    if (clean.credential) credentials[nextId] = clean.credential;
    if (nextId === "skillhub" && source.enabled && !credentials[nextId]) throw new SkillSourceError("auth-required", "Configure the SkillHub API key first", 401);
    writePrivateFileAtomicSync(join(sourceRoot(), "credentials.json"), JSON.stringify(credentials));
    writePrivateFileAtomicSync(join(sourceRoot(), "sources.json"), JSON.stringify([...saved, source]));
    return { ...source, hasCredential: Boolean(credentials[nextId]) };
  });
}
export async function removeSource(id: string, restore = false) {
  return withStoreLock(sourceRoot(), async () => {
    const source = getSource(id, false);
    if (source.builtin && !restore) throw new SkillSourceError("builtin", "Built-in sources can be disabled or restored");
    const credentials = secrets(); delete credentials[id];
    writePrivateFileAtomicSync(join(sourceRoot(), "sources.json"), JSON.stringify(records().filter(s => s.id !== id)));
    writePrivateFileAtomicSync(join(sourceRoot(), "credentials.json"), JSON.stringify(credentials));
  });
}
export function recordSourceStatus(source: SkillSource, state: SkillSource["state"], at?: string) {
  mkdirSync(sourceRoot(), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(join(sourceRoot(), `${source.id}.status.json`), JSON.stringify({ state, at }));
}
