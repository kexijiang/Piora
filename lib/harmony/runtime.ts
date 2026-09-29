import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";

import { HarmonyError } from "./errors";
import type { HarmonyConfig, HarmonyRuntimeCandidate } from "./types";

export interface HarmonyRuntimeResolution {
  hdcPath: string;
  source: "explicit" | "environment" | "config" | "deveco" | "path" | "bundled";
}

export interface ResolveHdcOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  config?: HarmonyConfig;
  homeDir?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  listDirectory?: (path: string) => string[];
  readTextFile?: (path: string) => string;
}

export interface DiscoverHdcOptions extends ResolveHdcOptions {
  selectionPath?: string;
}

const HDC_ENV_NAMES = ["PIORA_HARMONY_HDC_PATH", "HARMONY_HDC_PATH", "HDC_PATH"] as const;

function isUsableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function inferredPlatform(path: string | undefined): NodeJS.Platform {
  return path && /^[A-Za-z]:[\\/]/.test(path.trim()) ? "win32" : process.platform;
}

function normalizeCandidate(candidate: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!candidate?.trim()) return undefined;
  const paths = pathApi(platform);
  const absolute = paths.isAbsolute(candidate.trim()) ? candidate.trim() : paths.resolve(candidate.trim());
  return absolute;
}

function versionDirectories(root: string, listDirectory: (path: string) => string[]): string[] {
  try {
    return listDirectory(root)
      .filter((entry) => /^\d+(?:\.\d+)*(?:[-_A-Za-z0-9.]*)?$/.test(entry))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function devecoCandidates(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  listDirectory: (path: string) => string[],
  readTextFile: (path: string) => string,
): string[] {
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  const localAppData = env.LOCALAPPDATA || paths.join(homeDir, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const sdkRoots = [
    paths.join(localAppData, "Huawei", "Sdk"),
    paths.join(localAppData, "Huawei", "Sdk", "openharmony"),
    paths.join(homeDir, "Huawei", "Sdk"),
  ];
  const result = [
    paths.join(programFiles, "Huawei", "DevEco Studio", "sdk", "default", "openharmony", "toolchains", executable),
    paths.join(programFiles, "Huawei", "DevEco Studio", "sdk", "default", "toolchains", executable),
    paths.join(localAppData, "Programs", "Huawei", "DevEco Studio", "sdk", "default", "openharmony", "toolchains", executable),
  ];

  const huaweiConfigRoot = paths.join(localAppData, "Huawei");
  for (const directory of (() => { try { return listDirectory(huaweiConfigRoot); } catch { return []; } })()) {
    if (!/^DevEcoStudio/i.test(directory)) continue;
    try {
      const installHome = readTextFile(paths.join(huaweiConfigRoot, directory, ".home")).trim();
      if (!installHome) continue;
      result.push(paths.join(installHome, "sdk", "default", "openharmony", "toolchains", executable));
      result.push(paths.join(installHome, "sdk", "default", "toolchains", executable));
    } catch { /* custom install metadata is optional */ }
  }

  for (const sdkRoot of sdkRoots) {
    result.push(paths.join(sdkRoot, "default", "openharmony", "toolchains", executable));
    result.push(paths.join(sdkRoot, "default", "toolchains", executable));
    for (const version of versionDirectories(sdkRoot, listDirectory)) {
      result.push(paths.join(sdkRoot, version, "openharmony", "toolchains", executable));
      result.push(paths.join(sdkRoot, version, "toolchains", executable));
    }
  }
  return result;
}

function selectedCandidates(selectionPath: string, platform: NodeJS.Platform, listDirectory: (path: string) => string[]): string[] {
  const paths = pathApi(platform);
  const selected = normalizeCandidate(selectionPath, platform);
  if (!selected) return [];
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  if (paths.basename(selected).toLocaleLowerCase() === executable.toLocaleLowerCase()) return [selected];
  const roots = [selected];
  for (const version of versionDirectories(selected, listDirectory)) roots.push(paths.join(selected, version));
  return roots.flatMap((root) => [
    paths.join(root, executable),
    paths.join(root, "toolchains", executable),
    paths.join(root, "openharmony", "toolchains", executable),
    paths.join(root, "default", "toolchains", executable),
    paths.join(root, "default", "openharmony", "toolchains", executable),
  ]);
}

function inferSdkPath(hdcPath: string, platform: NodeJS.Platform): string {
  const paths = pathApi(platform);
  const toolchains = paths.dirname(hdcPath);
  return paths.basename(toolchains).toLocaleLowerCase() === "toolchains"
    ? paths.dirname(toolchains)
    : toolchains;
}

function bundledHdcCandidate(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const directory = env.PIORA_HARMONY_TOOLS_DIR?.trim();
  if (!directory) return undefined;
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  return paths.join(paths.resolve(directory), executable);
}

export function discoverHdcCandidates(options: DiscoverHdcOptions = {}): HarmonyRuntimeCandidate[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? isUsableFile;
  const listDirectory = options.listDirectory ?? ((path) => readdirSync(path));
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  const candidates: Array<{ path: string | undefined; source: HarmonyRuntimeCandidate["source"] }> = [];

  if (options.selectionPath) {
    candidates.push(...selectedCandidates(options.selectionPath, platform, listDirectory).map((path) => ({ path, source: "selection" as const })));
  }
  for (const name of HDC_ENV_NAMES) candidates.push({ path: env[name], source: "environment" });
  candidates.push({ path: options.config?.hdcPath, source: "config" });
  candidates.push(...devecoCandidates(homeDir, env, platform, listDirectory, readTextFile).map((path) => ({ path, source: "deveco" as const })));
  for (const directory of (env.PATH ?? "").split(paths.delimiter)) {
    if (directory.trim()) candidates.push({ path: paths.join(directory.replace(/^"|"$/g, ""), executable), source: "path" });
  }
  candidates.push({ path: bundledHdcCandidate(env, platform), source: "bundled" });

  const seen = new Set<string>();
  const result: HarmonyRuntimeCandidate[] = [];
  for (const candidate of candidates) {
    const hdcPath = normalizeCandidate(candidate.path, platform);
    if (!hdcPath || !exists(hdcPath)) continue;
    const key = platform === "win32" ? hdcPath.toLocaleLowerCase() : hdcPath;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ hdcPath, sdkPath: inferSdkPath(hdcPath, platform), source: candidate.source });
  }
  return result;
}

export function resolveHdcPath(options: ResolveHdcOptions = {}): HarmonyRuntimeResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? isUsableFile;
  const listDirectory = options.listDirectory ?? ((path) => readdirSync(path));
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";

  const check = (candidate: string | undefined): string | undefined => {
    const normalized = normalizeCandidate(candidate, platform);
    return normalized && exists(normalized) ? normalized : undefined;
  };

  const explicit = check(options.explicitPath);
  if (explicit) return { hdcPath: explicit, source: "explicit" };
  if (options.explicitPath?.trim()) {
    throw new HarmonyError("HDC_INVALID", "The configured HDC executable does not exist", {
      details: { source: "explicit" },
    });
  }

  for (const name of HDC_ENV_NAMES) {
    const environment = check(env[name]);
    if (environment) return { hdcPath: environment, source: "environment" };
  }

  const configured = check(options.config?.hdcPath);
  if (configured) return { hdcPath: configured, source: "config" };

  for (const candidate of devecoCandidates(homeDir, env, platform, listDirectory, readTextFile)) {
    const discovered = check(candidate);
    if (discovered) return { hdcPath: discovered, source: "deveco" };
  }

  for (const directory of (env.PATH ?? "").split(paths.delimiter)) {
    if (!directory.trim()) continue;
    const fromPath = check(paths.join(directory.replace(/^"|"$/g, ""), executable));
    if (fromPath) return { hdcPath: fromPath, source: "path" };
  }

  const bundled = check(bundledHdcCandidate(env, platform));
  if (bundled) return { hdcPath: bundled, source: "bundled" };

  throw new HarmonyError("HDC_NOT_FOUND", "HDC was not found in the system or the Piora application bundle.", {
    retryable: true,
  });
}

export function defaultHarmonyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.PIORA_HARMONY_CONFIG_PATH?.trim();
  if (requested) return pathApi(inferredPlatform(requested)).resolve(requested);
  const desktopData = env.PIORA_DESKTOP_DATA_DIR?.trim();
  if (desktopData) {
    const paths = pathApi(inferredPlatform(desktopData));
    return paths.join(paths.resolve(desktopData), "harmony.json");
  }
  const appData = env.APPDATA?.trim();
  const paths = pathApi(inferredPlatform(appData));
  const base = appData || paths.join(homedir(), ".piora");
  return paths.join(base, "Piora", "harmony.json");
}

export function readHarmonyConfig(path = defaultHarmonyConfigPath()): HarmonyConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as { hdcPath?: unknown; video?: unknown; storage?: unknown; vision?: unknown };
    const config: HarmonyConfig = {};
    if (typeof record.hdcPath === "string" && record.hdcPath.trim()) config.hdcPath = normalizeCandidate(record.hdcPath);
    if (record.video && typeof record.video === "object" && !Array.isArray(record.video)) {
      const video = record.video as Record<string, unknown>;
      if (video.provider === "bundled" || video.provider === "hos-scrcpy") config.video = {
        provider: video.provider,
        ...(typeof video.packageDirectory === "string" && video.packageDirectory.trim() ? { packageDirectory: video.packageDirectory.trim() } : {}),
        ...(typeof video.javaPath === "string" && video.javaPath.trim() ? { javaPath: video.javaPath.trim() } : {}),
      };
    }
    if (record.storage && typeof record.storage === "object" && !Array.isArray(record.storage)) {
      const storage = record.storage as Record<string, unknown>;
      const screenshotDirectory = typeof storage.screenshotDirectory === "string" && storage.screenshotDirectory.trim()
        ? normalizeCandidate(storage.screenshotDirectory)
        : undefined;
      const recordingDirectory = typeof storage.recordingDirectory === "string" && storage.recordingDirectory.trim()
        ? normalizeCandidate(storage.recordingDirectory)
        : undefined;
      if (screenshotDirectory || recordingDirectory) {
        config.storage = {
          ...(screenshotDirectory ? { screenshotDirectory } : {}),
          ...(recordingDirectory ? { recordingDirectory } : {}),
        };
      }
    }
    if (record.vision && typeof record.vision === "object" && !Array.isArray(record.vision)) {
      const vision = record.vision as Record<string, unknown>;
      if (typeof vision.enabled === "boolean" && typeof vision.provider === "string" && typeof vision.modelId === "string") {
        const provider = vision.provider.trim();
        const modelId = vision.modelId.trim();
        if (provider && modelId) {
          config.vision = {
            enabled: vision.enabled,
            provider,
            modelId,
            ...(vision.shareScreenshotWithActionModel === true ? { shareScreenshotWithActionModel: true } : {}),
          };
        }
      }
    }
    return config;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return {};
    throw new HarmonyError("INTERNAL_ERROR", "Unable to read Harmony device configuration", { cause: error });
  }
}

export function writeHarmonyConfig(config: HarmonyConfig, path = defaultHarmonyConfigPath()): HarmonyConfig {
  const normalized: HarmonyConfig = {};
  if (config.hdcPath?.trim()) {
    const requested = config.hdcPath.trim();
    const paths = pathApi(inferredPlatform(requested));
    if (!paths.isAbsolute(requested)) {
      throw new HarmonyError("INVALID_ARGUMENT", "HDC path must be absolute");
    }
    const absolute = normalizeCandidate(requested, inferredPlatform(requested));
    if (!absolute) throw new HarmonyError("INVALID_ARGUMENT", "HDC path must be absolute");
    normalized.hdcPath = absolute;
  }
  if (config.video) {
    if (config.video.provider !== "bundled" && config.video.provider !== "hos-scrcpy") throw new HarmonyError("INVALID_ARGUMENT", "Unknown video provider");
    const packageDirectory = config.video.packageDirectory?.trim();
    const javaPath = config.video.javaPath?.trim();
    if (config.video.provider === "hos-scrcpy" && (!packageDirectory || !pathApi(inferredPlatform(packageDirectory)).isAbsolute(packageDirectory))) {
      throw new HarmonyError("INVALID_ARGUMENT", "HOScrcpy package directory must be absolute");
    }
    if (javaPath && !pathApi(inferredPlatform(javaPath)).isAbsolute(javaPath)) throw new HarmonyError("INVALID_ARGUMENT", "Java executable path must be absolute");
    normalized.video = { provider: config.video.provider,
      ...(packageDirectory ? { packageDirectory: normalizeCandidate(packageDirectory, inferredPlatform(packageDirectory)) } : {}),
      ...(javaPath ? { javaPath: normalizeCandidate(javaPath, inferredPlatform(javaPath)) } : {}) };
  }
  if (config.storage) {
    const normalizeStoragePath = (value: string | undefined, label: string): string | undefined => {
      if (!value?.trim()) return undefined;
      const requested = value.trim();
      const paths = pathApi(inferredPlatform(requested));
      if (!paths.isAbsolute(requested)) throw new HarmonyError("INVALID_ARGUMENT", `${label} must be an absolute path`);
      return paths.resolve(requested);
    };
    const screenshotDirectory = normalizeStoragePath(config.storage.screenshotDirectory, "Screenshot directory");
    const recordingDirectory = normalizeStoragePath(config.storage.recordingDirectory, "Recording directory");
    if (screenshotDirectory || recordingDirectory) {
      normalized.storage = {
        ...(screenshotDirectory ? { screenshotDirectory } : {}),
        ...(recordingDirectory ? { recordingDirectory } : {}),
      };
    }
  }
  if (config.vision) {
    const provider = config.vision.provider.trim();
    const modelId = config.vision.modelId.trim();
    if (!provider || !modelId || provider.length > 160 || modelId.length > 240) {
      throw new HarmonyError("INVALID_ARGUMENT", "Vision provider and model are required and must be within limits");
    }
    normalized.vision = {
      enabled: Boolean(config.vision.enabled),
      provider,
      modelId,
      ...(config.vision.shareScreenshotWithActionModel ? { shareScreenshotWithActionModel: true } : {}),
    };
  }
  try {
    mkdirSync(pathApi(inferredPlatform(path)).dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return normalized;
  } catch (error) {
    throw new HarmonyError("INTERNAL_ERROR", "Unable to save Harmony device configuration", { cause: error });
  }
}

export function isHdcPathPresent(path: string): boolean {
  return existsSync(path) && isUsableFile(path);
}
