import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DesktopUpdateSource = "github" | "internal";
export interface UpdateSourceFeed { releasesAtomUrl: string; releaseDownloadRoot: string }
// Internal maintainers replace both URLs with their HTTPS release mirror.
// The mirror contract is documented in docs/desktop-update-sources.md.
export const UPDATE_SOURCE_FEEDS: Record<DesktopUpdateSource, UpdateSourceFeed> = {
  github: { releasesAtomUrl: "https://github.com/kexijiang/Piora/releases.atom", releaseDownloadRoot: "https://github.com/kexijiang/Piora/releases/download" },
  internal: { releasesAtomUrl: "https://piora-updates.example.invalid/releases.atom", releaseDownloadRoot: "https://piora-updates.example.invalid/releases/download" },
};
export const DEFAULT_UPDATE_SOURCE: DesktopUpdateSource = "github";
export function parseUpdateSource(value: unknown): DesktopUpdateSource {
  if (value !== "github" && value !== "internal") throw new Error("Invalid update source");
  return value;
}
export function configuredUpdateFeed(source: DesktopUpdateSource): UpdateSourceFeed {
  const feed = UPDATE_SOURCE_FEEDS[source];
  for (const value of [feed.releasesAtomUrl, feed.releaseDownloadRoot]) {
    const url = new URL(value);
    if (url.hostname.endsWith(".invalid")) throw new Error("Internal update source is not configured / 内源更新地址未配置");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Update source must use HTTPS without embedded credentials, query or fragment");
  }
  return feed;
}
export function readUpdateSource(directory: string): DesktopUpdateSource {
  try {
    const saved = JSON.parse(readFileSync(join(directory, "update-source.json"), "utf8"));
    return saved?.schema === 1 ? parseUpdateSource(saved.source) : DEFAULT_UPDATE_SOURCE;
  }
  catch { return DEFAULT_UPDATE_SOURCE; }
}
export function writeUpdateSource(directory: string, source: DesktopUpdateSource): void {
  parseUpdateSource(source);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "update-source.json");
  const temp = target + "." + process.pid + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify({ schema: 1, source }) + "\n", "utf8");
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* keep the original persistence error */ }
    throw error;
  }
}
