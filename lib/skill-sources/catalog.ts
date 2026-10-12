import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { fetchBundle, fetchCatalog } from "./adapters";
import { getSource, readJson, recordSourceStatus, sourceCacheKey, sourceRoot } from "./store";
import { SkillSourceError, type CatalogPage } from "./types";

const TTL = 15 * 60_000;
export async function catalogPage(sourceId: string, query = "", cursor?: string, refresh = false): Promise<CatalogPage> {
  const source = getSource(sourceId, false);
  if (source.id === "skillhub" && !source.hasCredential) return { sourceId, items: [], state: "auth-required" };
  if (!source.enabled) return { sourceId, items: [], state: "disabled" };
  if (query.length > 500 || (cursor && cursor.length > 4096)) throw new SkillSourceError("invalid", "Query or cursor is too long");
  const hash = createHash("sha256").update(JSON.stringify([sourceId, sourceCacheKey(source), query, cursor])).digest("hex");
  const directory = join(sourceRoot(), "cache");
  const file = join(directory, `${hash}.json`);
  const cached = readJson<CatalogPage | null>(file, null);
  if (!refresh && cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < TTL) return cached;
  try {
    const page = await fetchCatalog(source, query, cursor, undefined, refresh);
    if (page.state === "ready") {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(file, JSON.stringify(page));
      recordSourceStatus(source, "ready", page.fetchedAt);
    }
    return page;
  } catch (error) {
    const state = error instanceof SkillSourceError && error.code === "auth-required" ? "auth-required" : "error";
    recordSourceStatus(source, state, cached?.fetchedAt);
    return { sourceId, items: [], ...cached, state, stale: Boolean(cached), error: error instanceof SkillSourceError ? error.message : "Source connection failed" };
  }
}
export async function remoteSkillDetail(sourceId: string, id: string, version?: string) {
  return (await fetchBundle(getSource(sourceId), id, version)).detail;
}
