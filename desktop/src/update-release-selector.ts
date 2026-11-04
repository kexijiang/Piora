import type { UpdateSourceFeed } from "./update-source.js";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "./logger.js";
import type { DesktopReleaseAudience } from "./release-audience.js";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";
import { validateBrandUpdateInfo, type UpdateBrand } from "./update-brand-validation.js";

export interface DesktopReleaseCandidate {
  tag: string;
  version: string;
  channel: "latest" | "beta";
}

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  beta: number | null;
}

const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const RELEASE_TAG_LINK_PATTERN = /\/releases\/tag\/([^"&<\s]+)/gi;
const RELEASES_ATOM_URL = "https://github.com/kexijiang/Piora/releases.atom";
const RELEASE_DOWNLOAD_ROOT = "https://github.com/kexijiang/Piora/releases/download";

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const [, major, minor, patch, beta] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    raw: `${major}.${minor}.${patch}${beta === undefined ? "" : `-beta.${beta}`}`,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    beta: beta === undefined ? null : Number(beta),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.beta === null && right.beta === null) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}

export function releaseTagsFromAtom(feedXml: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of feedXml.matchAll(RELEASE_TAG_LINK_PATTERN)) {
    const encoded = match[1];
    if (!encoded) continue;
    let tag: string;
    try {
      tag = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function selectDesktopReleaseCandidate(
  tags: readonly string[],
  currentVersion: string,
  audience: DesktopReleaseAudience,
): DesktopReleaseCandidate | null {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error(`Current desktop version is not supported by the updater: ${currentVersion}`);

  let selected: { tag: string; parsed: ParsedVersion } | undefined;
  for (const tag of tags) {
    const parsed = parseVersion(tag);
    if (!parsed || (audience === "stable" && parsed.beta !== null)) continue;
    if (compareVersions(parsed, current) <= 0) continue;
    if (!selected || compareVersions(parsed, selected.parsed) > 0) {
      selected = { tag, parsed };
    }
  }
  if (!selected) return null;
  return {
    tag: selected.tag,
    version: selected.parsed.raw,
    channel: selected.parsed.beta === null ? "latest" : "beta",
  };
}

export async function preparePreviewUpdateFeed(
  updater: AppUpdater,
  currentVersion: string,
  fetchResource: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  logger: Logger,
  options?: { audience: DesktopReleaseAudience; brand: UpdateBrand; feed?: UpdateSourceFeed; onLatestVersion?: (version: string | undefined) => void },
): Promise<boolean> {
  const response = await fetchResource(options?.feed?.releasesAtomUrl ?? RELEASES_ATOM_URL);
  if (!response.ok) throw new Error(`Release feed returned HTTP ${response.status}`);
  let tags = releaseTagsFromAtom(await response.text());
  options?.onLatestVersion?.(undefined);
  while (tags.length > 0) {
    const candidate = selectDesktopReleaseCandidate(tags, options?.onLatestVersion ? "0.0.0" : currentVersion, options?.audience ?? "preview");
    if (!candidate) break;
    const channel = options
      ? options.brand.updateChannels[candidate.channel === "beta" ? "preview" : "stable"]
      : candidate.channel;
    const releaseUrl = `${options?.feed?.releaseDownloadRoot ?? RELEASE_DOWNLOAD_ROOT}/${encodeURIComponent(candidate.tag)}`;
    // GitHub's Atom feed also includes tags without a published release. Only
    // hand a candidate to electron-updater once its channel metadata exists.
    const metadataUrl = `${releaseUrl}/${channel}.yml`;
    const metadata = await fetchResource(metadataUrl);
    if (metadata.status === 404 || metadata.status === 410) {
      logger.info("Skipping desktop release without update metadata", { ...candidate, status: metadata.status });
      tags = tags.filter((tag) => tag !== candidate.tag);
      continue;
    }
    if (!metadata.ok) {
      throw new Error(`Update metadata for ${candidate.tag} returned HTTP ${metadata.status}`);
    }
    const metadataText = await metadata.text();
    if (options) validateBrandUpdateInfo(parseUpdateInfo(metadataText, `${channel}.yml`, new URL(metadataUrl)), options.brand, candidate.version);

    options?.onLatestVersion?.(candidate.version);
    if (!selectDesktopReleaseCandidate([candidate.tag], currentVersion, options?.audience ?? "preview")) return false;

    updater.allowPrerelease = (options?.audience ?? "preview") === "preview";
    updater.channel = channel;
    updater.allowDowngrade = false;
    updater.setFeedURL({ provider: "generic", url: releaseUrl, channel });
    logger.info("Selected desktop update candidate", candidate);
    return true;
  }

  logger.info("No eligible preview or stable desktop update is available", { currentVersion });
  return false;
}
