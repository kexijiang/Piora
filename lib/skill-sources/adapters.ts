import { runNpx } from "../npx";
import { apiUrl, array, httpLink, object, readResponse, sourceJson, sourceRequest, string } from "./http";
import { contentHash, skillMetadata, unzipSkill, validateFiles } from "./content";
import { gitBundle, gitCatalog } from "./git";
import { normalizeInput, sourceCredential } from "./store";
import { SkillSourceError, type CatalogPage, type CatalogSkill, type SkillBundle, type SkillSource } from "./types";

function pageNumber(cursor?: string) {
  if (cursor && !/^\d{1,6}$/.test(cursor)) throw new SkillSourceError("cursor", "Invalid page cursor");
  return Number(cursor || 0);
}
function validateId(id: string) {
  if (!id || id.length > 1024 || /[\x00-\x1f\\?#]/.test(id) || id.split("/").some(p => p === ".." || p === "." || !p)) throw new SkillSourceError("id", "Invalid skill identifier");
}
function item(source: SkillSource, raw: Record<string, unknown>): CatalogSkill {
  const owner = string(raw.ownerHandle) || string(object(raw.owner).handle) || string(raw.ownerName);
  const slug = string(raw.slug);
  const id = source.kind === "skills-sh" ? string(raw.id) || `${string(raw.source)}/${slug || string(raw.name)}` : source.kind === "clawhub" && owner ? `@${owner.replace(/^@/, "")}/${slug}` : slug;
  validateId(id);
  return { sourceId: source.id, id, name: string(raw.displayName) || string(raw.name) || slug,
    description: string(raw.summary) || string(raw.description) || undefined, publisher: owner || string(raw.source) || undefined,
    version: string(raw.version) || string(object(raw.latestVersion).version) || string(object(raw.tags).latest) || undefined,
    downloads: typeof raw.downloads === "number" ? raw.downloads : typeof raw.installs === "number" ? raw.installs : undefined,
    url: httpLink(raw.url) || httpLink(raw.homepage) || (source.id === "skills-sh" ? `https://skills.sh/${id}` : undefined) };
}
export async function legacySkillsSearch(query: string): Promise<CatalogSkill[]> {
  const source: SkillSource = { id: "skills-sh", name: "skills.sh", kind: "skills-sh", url: process.env.SKILLS_API_URL || "https://skills.sh", enabled: true };
  try {
    const data = await sourceJson(source, "/api/search", { q: query, limit: "50" }, "");
    if (!Array.isArray(data.skills)) throw new Error("Invalid legacy search response");
    return array(data.skills).map(raw => item(source, { ...raw, id: string(raw.id) || `${string(raw.source)}/${string(raw.name)}` }));
  } catch {
    try {
      const { stdout, stderr } = await runNpx(["skills", "find", query], { timeout: 20_000, env: { ...process.env, FORCE_COLOR: "0" } });
      const output = `${stdout}\n${stderr}`.replace(/\x1B\[[0-9;]*m/g, "");
      return [...output.matchAll(/^([\w.-]+\/[\w.-]+)@([\w.-]+)\s+.*$/gm)].map(m => ({ sourceId: source.id, id: `${m[1]}/${m[2]}`, name: m[2], publisher: m[1], url: `https://skills.sh/${m[1]}/${m[2]}` }));
    } catch { throw new SkillSourceError("network", "skills.sh search is unavailable", 502); }
  }
}
export async function fetchCatalog(source: SkillSource, query = "", cursor?: string, credential?: string, refresh = false): Promise<CatalogPage> {
  let items: CatalogSkill[] = [], nextCursor: string | undefined;
  if (source.kind === "git") {
    const all = (await gitCatalog(source, refresh)).filter(s => `${s.name} ${s.description || ""}`.toLowerCase().includes(query.toLowerCase()));
    const offset = pageNumber(cursor) * 30;
    items = all.slice(offset, offset + 30); if (offset + 30 < all.length) nextCursor = String(pageNumber(cursor) + 1);
  } else if (source.id === "skills-sh" && !credential && !sourceCredential(source.id)) {
    if (!query) return { sourceId: source.id, state: "unsupported", items: [] };
    items = await legacySkillsSearch(query);
  } else if (source.kind === "skills-sh") {
    const page = pageNumber(cursor);
    const data = await sourceJson(source, query ? "/api/v1/skills/search" : "/api/v1/skills", query ? { q: query, limit: "30" } : { page: String(page), per_page: "30" }, credential);
    if (!Array.isArray(data.data)) throw new SkillSourceError("protocol", "Expected a skills.sh data array", 502);
    items = array(data.data).map(raw => item(source, raw));
    if (!query && object(data.pagination).hasMore) nextCursor = String(page + 1);
  } else if (source.kind === "skillhub") {
    const page = pageNumber(cursor) + 1;
    const data = object((await sourceJson(source, "/api/skills", { page: String(page), pageSize: "30", sortBy: "downloads", keyword: query || undefined }, credential)).data);
    if (!Array.isArray(data.skills)) throw new SkillSourceError("protocol", "Expected a SkillHub skills array", 502);
    items = array(data.skills).map(raw => item(source, raw));
    if (typeof data.total === "number" && page * 30 < data.total) nextCursor = String(page);
  } else {
    const data = await sourceJson(source, query ? "/api/v1/search" : "/api/v1/skills", query ? { q: query, limit: "30", nonSuspiciousOnly: "true" } : { limit: "30", cursor, sort: "downloads", nonSuspiciousOnly: "true" }, credential);
    if (!Array.isArray(query ? data.results : data.items)) throw new SkillSourceError("protocol", "Expected a ClawHub skills array", 502);
    items = array(query ? data.results : data.items).map(raw => item(source, raw));
    if (!query) nextCursor = string(data.nextCursor) || undefined;
  }
  return { sourceId: source.id, state: "ready", items, nextCursor, fetchedAt: new Date().toISOString() };
}
async function skillsShGitBundle(source: SkillSource, id: string, version?: string): Promise<SkillBundle> {
  const parts = id.split("/");
  if (parts.length !== 3 || parts.some(s => !/^[\w.-]+$/.test(s))) throw new SkillSourceError("unsupported", "This skills.sh result requires its authenticated file API");
  const repo: SkillSource = { ...source, kind: "git", url: `https://github.com/${parts[0]}/${parts[1]}.git` };
  const found = (await gitCatalog(repo, !version)).find(s => s.name === parts[2]);
  if (!found) throw new SkillSourceError("missing", "Skill no longer exists in its source repository", 404);
  const bundle = await gitBundle(repo, found.id, version || found.version);
  bundle.detail.id = id; bundle.detail.url = `https://skills.sh/${id}`; bundle.detail.publisher = `${parts[0]}/${parts[1]}`;
  return bundle;
}
export async function fetchBundle(source: SkillSource, id: string, version?: string): Promise<SkillBundle> {
  validateId(id);
  if (version && (version.length > 256 || /[\x00-\x1f]/.test(version))) throw new SkillSourceError("version", "Invalid skill version");
  if (source.kind === "git") return gitBundle(source, id, version);
  if (source.id === "skills-sh" && !sourceCredential(source.id)) return skillsShGitBundle(source, id, version);
  if (source.kind === "skills-sh") {
    const data = await sourceJson(source, `/api/v1/skills/${id.split("/").map(encodeURIComponent).join("/")}`);
    if (!Array.isArray(data.files)) throw new SkillSourceError("unsupported", "This source does not provide a file snapshot", 409);
    const files = new Map<string, Buffer>();
    for (const file of array(data.files)) {
      if (!string(file.path) || typeof file.contents !== "string" || files.has(string(file.path))) throw new SkillSourceError("format", "Invalid file snapshot");
      files.set(string(file.path), Buffer.from(file.contents));
    }
    validateFiles(files);
    const currentVersion = string(data.hash) || contentHash(files);
    if (version && version !== currentVersion) throw new SkillSourceError("changed", "Skill changed since preview; open its details again", 409);
    return { files, detail: { sourceId: source.id, id, ...skillMetadata(files), version: currentVersion, files: [...files.keys()], url: httpLink(`${source.url}/${id}`) } };
  }
  const qualified = source.kind === "clawhub" ? /^@([^/]+)\/(.+)$/.exec(id) : null;
  const slug = qualified ? qualified[2] : id;
  const owner = qualified?.[1];
  const data = await sourceJson(source, `/api/v1/skills/${encodeURIComponent(slug)}`, { owner });
  if (!object(data.skill).slug) throw new SkillSourceError("protocol", "Invalid skill detail", 502);
  if (owner && string(object(data.owner).handle).toLowerCase() !== owner.toLowerCase()) throw new SkillSourceError("identity", "Source returned a different publisher", 409);
  if (object(data.moderation).isMalwareBlocked) throw new SkillSourceError("blocked", "Source has blocked this skill", 403);
  const latestVersion = string(object(data.latestVersion).version);
  const gitVersion = !latestVersion && version && /^[0-9a-f]{40,64}$/i.test(version) ? version : undefined;
  const currentVersion = gitVersion ? "" : version || latestVersion;
  const response = await sourceRequest(source, apiUrl(source, "/api/v1/download", { slug, owner, version: currentVersion || undefined }));
  const bytes = await readResponse(response);
  let files: Map<string, Buffer>, resolvedVersion = currentVersion;
  if (response.headers.get("content-type")?.includes("json")) {
    const handoff = object(JSON.parse(bytes.toString("utf8")));
    if (handoff.sourceRef !== "public-github" || !/^[\w.-]+\/[\w.-]+$/.test(string(handoff.repo)) || !/^[0-9a-f]{40,64}$/i.test(string(handoff.commit))) throw new SkillSourceError("protocol", "Invalid Git source handoff");
    if (gitVersion && handoff.commit !== gitVersion) throw new SkillSourceError("changed", "Git-backed skill changed since preview; open its details again", 409);
    const gitSource: SkillSource = { ...source, ...normalizeInput({ name: source.name, kind: "git", url: `https://github.com/${handoff.repo}.git` }) };
    const path = string(handoff.path).replace(/\/$/, "");
    const bundle = await gitBundle(gitSource, path.endsWith("SKILL.md") ? path : path ? `${path}/SKILL.md` : "SKILL.md", string(handoff.commit));
    files = bundle.files; resolvedVersion = string(handoff.commit);
    // Always fetch the exact commit/path ourselves; never trust an arbitrary archiveUrl.
  } else {
    if (!currentVersion) throw new SkillSourceError("version", "Source did not supply an immutable version", 502);
    files = await unzipSkill(bytes);
  }
  const metadata = skillMetadata(files);
  return { files, detail: { sourceId: source.id, id, ...metadata, version: resolvedVersion, files: [...files.keys()], publisher: string(object(data.owner).handle) || undefined,
    url: httpLink(object(data.skill).url) || httpLink(`${source.url}/${source.kind === "clawhub" ? id.replace(/^@/, "").replace(/\/(?!.*\/)/, "/skills/") : `skills/${encodeURIComponent(id)}`}`) } };
}
