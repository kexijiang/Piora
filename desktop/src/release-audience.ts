import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export type DesktopReleaseAudience = "stable" | "preview";

interface PersistedReleaseAudience {
  schema: 1;
  audience: DesktopReleaseAudience;
  enrolledAt: string;
  sourceVersion: string;
}

const PREVIEW_VERSION_PATTERN = /^(?:v)?\d+\.\d+\.\d+-beta\.\d+$/;
export const RELEASE_AUDIENCE_FILE = "release-audience.json";

export function inferDesktopBuildAudience(version: string): DesktopReleaseAudience {
  return PREVIEW_VERSION_PATTERN.test(version.trim()) ? "preview" : "stable";
}

function audiencePath(userDataDirectory: string): string {
  return join(userDataDirectory, RELEASE_AUDIENCE_FILE);
}

function readPersistedAudience(
  userDataDirectory: string,
  logger: Logger,
): DesktopReleaseAudience | undefined {
  try {
    const parsed = JSON.parse(readFileSync(audiencePath(userDataDirectory), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const marker = parsed as Partial<PersistedReleaseAudience>;
    if (marker.schema !== 1) return undefined;
    return marker.audience === "preview" || marker.audience === "stable"
      ? marker.audience
      : undefined;
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
    if (code !== "ENOENT") logger.warn("Unable to read desktop release audience", error);
    return undefined;
  }
}

function persistAudience(
  userDataDirectory: string,
  audience: DesktopReleaseAudience,
  sourceVersion: string,
  logger: Logger,
): void {
  const targetPath = audiencePath(userDataDirectory);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  const marker: PersistedReleaseAudience = {
    schema: 1,
    audience,
    enrolledAt: new Date().toISOString(),
    sourceVersion,
  };
  try {
    mkdirSync(userDataDirectory, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary marker may not have been created.
    }
    logger.warn("Unable to persist desktop release audience", error);
  }
}

/**
 * Enrollment is intentionally write-once. An installer can replace the app,
 * but it cannot silently move an existing installation between audiences.
 */
export function readOrCreateDesktopReleaseAudience(
  userDataDirectory: string,
  currentVersion: string,
  logger: Logger,
): DesktopReleaseAudience {
  const persisted = readPersistedAudience(userDataDirectory, logger);
  if (persisted) return persisted;

  const audience = inferDesktopBuildAudience(currentVersion);
  persistAudience(userDataDirectory, audience, currentVersion, logger);
  return audience;
}
