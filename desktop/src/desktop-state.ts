import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { parseUpdateSchedule, type UpdateSchedule } from "./update-schedule.js";

interface DesktopState {
  lastLaunchedVersion?: string;
  updateSchedule?: UpdateSchedule;
  serverPort?: number;
  companionWindowPosition?: CompanionWindowPosition;
  mainWindowState?: MainWindowState;
  piAgentDirectory?: string | null;
}

export function readLastLaunchedVersion(directory: string, logger: Logger): string | undefined {
  const value = readDesktopState(directory, logger).lastLaunchedVersion;
  return typeof value === "string" ? value : undefined;
}

export function writeLastLaunchedVersion(directory: string, version: string, logger: Logger): boolean {
  return writeDesktopState(directory, { lastLaunchedVersion: version }, logger);
}

export function readUpdateSchedule(directory: string, logger: Logger): UpdateSchedule {
  try { return parseUpdateSchedule(readDesktopState(directory, logger).updateSchedule); }
  catch { return { enabled: false, time: "03:00" }; }
}

export function writeUpdateSchedule(directory: string, schedule: UpdateSchedule, logger: Logger): boolean {
  return writeDesktopState(directory, { updateSchedule: parseUpdateSchedule(schedule) }, logger);
}

export type RuntimeProfile = "normal" | "device-control";

/**
 * Device control now shares the ordinary desktop service. Preserve a legacy
 * device-control harmony.json on first launch so existing HDC/vision choices
 * survive the unified-runtime migration.
 */
export function runtimeProfileDataDirectory(
  userDataDirectory: string,
  profile: RuntimeProfile,
): string {
  void profile; // Kept for source compatibility with pre-0.2.2 callers.
  const unifiedDirectory = join(userDataDirectory, "runtime", "normal");
  const unifiedConfig = join(unifiedDirectory, "harmony.json");
  const legacyConfig = join(userDataDirectory, "runtime", "device-control", "harmony.json");
  if (!existsSync(unifiedConfig) && existsSync(legacyConfig)) {
    try {
      mkdirSync(unifiedDirectory, { recursive: true });
      copyFileSync(legacyConfig, unifiedConfig);
    } catch {
      // Automatic HDC discovery remains available if the one-time migration fails.
    }
  }
  return unifiedDirectory;
}
export interface CompanionWindowPosition {
  x: number;
  y: number;
}

export interface MainWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65_535;
}

function statePath(userDataDirectory: string): string {
  return join(userDataDirectory, "desktop-state.json");
}

function readDesktopState(userDataDirectory: string, logger: Logger): DesktopState {
  try {
    const value = JSON.parse(readFileSync(statePath(userDataDirectory), "utf8")) as unknown;
    return value && typeof value === "object" ? value as DesktopState : {};
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
    if (code !== "ENOENT") logger.warn("Unable to read desktop state", error);
    return {};
  }
}

function writeDesktopState(
  userDataDirectory: string,
  patch: Partial<DesktopState>,
  logger: Logger,
): boolean {
  try {
    const state = { ...readDesktopState(userDataDirectory, logger), ...patch };
    const targetPath = statePath(userDataDirectory);
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, targetPath);
    return true;
  } catch (error) {
    try {
      unlinkSync(`${statePath(userDataDirectory)}.${process.pid}.tmp`);
    } catch {
      // The temporary file may not have been created.
    }
    logger.warn("Unable to persist desktop state", error);
    return false;
  }
}

export function readPiAgentDirectory(userDataDirectory: string, logger: Logger): string | undefined {
  const value = readDesktopState(userDataDirectory, logger).piAgentDirectory;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function writePiAgentDirectory(
  userDataDirectory: string,
  directory: string | null,
  logger: Logger,
): boolean {
  return writeDesktopState(userDataDirectory, { piAgentDirectory: directory }, logger);
}

export function readPreferredServerPort(
  userDataDirectory: string,
  logger: Logger,
): number | undefined {
  const state = readDesktopState(userDataDirectory, logger);
  return isValidPort(state.serverPort) ? state.serverPort : undefined;
}

export function writePreferredServerPort(
  userDataDirectory: string,
  port: number,
  logger: Logger,
): void {
  if (!isValidPort(port)) return;
  writeDesktopState(userDataDirectory, { serverPort: port }, logger);
}

function isValidPosition(value: unknown): value is CompanionWindowPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Number.isInteger(candidate.x)
    && Number.isInteger(candidate.y)
    && Math.abs(Number(candidate.x)) <= 100_000
    && Math.abs(Number(candidate.y)) <= 100_000;
}

export function readCompanionWindowPosition(
  userDataDirectory: string,
  logger: Logger,
): CompanionWindowPosition | undefined {
  const state = readDesktopState(userDataDirectory, logger);
  return isValidPosition(state.companionWindowPosition)
    ? state.companionWindowPosition
    : undefined;
}

export function writeCompanionWindowPosition(
  userDataDirectory: string,
  position: CompanionWindowPosition,
  logger: Logger,
): void {
  if (!isValidPosition(position)) return;
  writeDesktopState(userDataDirectory, { companionWindowPosition: position }, logger);
}

function isValidMainWindowState(value: unknown): value is MainWindowState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return [state.x, state.y, state.width, state.height].every(Number.isInteger)
    && Number(state.width) >= 640
    && Number(state.height) >= 480
    && Number(state.width) <= 20_000
    && Number(state.height) <= 20_000
    && Math.abs(Number(state.x)) <= 100_000
    && Math.abs(Number(state.y)) <= 100_000
    && typeof state.maximized === "boolean";
}

export function readMainWindowState(userDataDirectory: string, logger: Logger): MainWindowState | undefined {
  const state = readDesktopState(userDataDirectory, logger);
  return isValidMainWindowState(state.mainWindowState) ? state.mainWindowState : undefined;
}

export function writeMainWindowState(userDataDirectory: string, state: MainWindowState, logger: Logger): void {
  if (!isValidMainWindowState(state)) return;
  writeDesktopState(userDataDirectory, { mainWindowState: state }, logger);
}
