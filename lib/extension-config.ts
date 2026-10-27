import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  type Extension,
  type LoadExtensionsResult,
  type PathMetadata,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  FIRST_PARTY_EXTENSIONS,
  firstPartyExtensionPath,
  getFirstPartyExtensionByPath,
  type FirstPartyExtensionDescriptor,
} from "./first-party-extensions";

const EXTENSION_SETTINGS_VERSION = 1;

function defaultDisabledExtensionIds(): string[] {
  return FIRST_PARTY_EXTENSIONS
    .filter((descriptor) => descriptor.defaultEnabled === false)
    .map((descriptor) => descriptor.id)
    .sort();
}

function defaultExtensionPreferences(): ExtensionPreferences {
  return { version: EXTENSION_SETTINGS_VERSION, disabled: defaultDisabledExtensionIds() };
}

export interface ExtensionPreferences {
  version: typeof EXTENSION_SETTINGS_VERSION;
  disabled: string[];
}

export interface ExtensionInventoryItem {
  id: string;
  name: string;
  description?: string;
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  builtIn: boolean;
  required: boolean;
  enabled: boolean;
  tools: string[];
  commands: string[];
  configurable: boolean;
}

export interface ExtensionsResponse {
  extensions: ExtensionInventoryItem[];
  diagnostics: Array<{ path: string; error: string }>;
  reloadRequired?: boolean;
}

export function extensionPreferencesPath(agentDir = getAgentDir()): string {
  return resolve(agentDir, "piora", "extensions.json");
}

export function readExtensionPreferences(path = extensionPreferencesPath()): ExtensionPreferences {
  try {
    if (!existsSync(path)) return defaultExtensionPreferences();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionPreferences>;
    if (parsed.version !== EXTENSION_SETTINGS_VERSION || !Array.isArray(parsed.disabled)) {
      return defaultExtensionPreferences();
    }
    return {
      version: EXTENSION_SETTINGS_VERSION,
      disabled: [...new Set(parsed.disabled.filter((id): id is string => typeof id === "string" && id.length > 0))].sort(),
    };
  } catch {
    return defaultExtensionPreferences();
  }
}

export function setExtensionEnabled(
  id: string,
  enabled: boolean,
  path = extensionPreferencesPath(),
): ExtensionPreferences {
  const required = FIRST_PARTY_EXTENSIONS.find((descriptor) => descriptor.id === id)?.required === true;
  if (required && !enabled) {
    throw new Error("Piora core capability extensions cannot be disabled.");
  }
  const current = readExtensionPreferences(path);
  const disabled = new Set(current.disabled);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  const next: ExtensionPreferences = {
    version: EXTENSION_SETTINGS_VERSION,
    disabled: [...disabled].sort(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function normalizedPath(path: string): string {
  const resolved = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function extensionIdFromSource(path: string, sourceInfo: PathMetadata): string {
  const firstParty = getFirstPartyExtensionByPath(path);
  if (firstParty) return firstParty.id;
  if (sourceInfo.origin === "package") {
    const resourcePath = sourceInfo.baseDir
      ? relative(sourceInfo.baseDir, path).replaceAll("\\", "/")
      : basename(path);
    return `package:${sourceInfo.scope}:${sourceInfo.source}:${resourcePath}`;
  }
  return `path:${sourceInfo.scope}:${normalizedPath(path)}`;
}

export function extensionId(extension: Extension): string {
  return extensionIdFromSource(extension.resolvedPath, extension.sourceInfo);
}

export function isExtensionEnabled(
  extension: Extension,
  preferences = readExtensionPreferences(),
): boolean {
  if (getFirstPartyExtensionByPath(extension.resolvedPath)?.required) return true;
  return !preferences.disabled.includes(extensionId(extension));
}

export function isExtensionIdEnabled(
  id: string,
  preferences = readExtensionPreferences(),
): boolean {
  if (FIRST_PARTY_EXTENSIONS.some((descriptor) => descriptor.id === id && descriptor.required)) return true;
  return !preferences.disabled.includes(id);
}

export function filterConfiguredExtensions(
  result: LoadExtensionsResult,
  preferences = readExtensionPreferences(),
): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.filter((extension) => isExtensionEnabled(extension, preferences)),
  };
}

export function enabledFirstPartyExtensionPaths(
  profile: "normal" | "device-control",
  preferences = readExtensionPreferences(),
): string[] {
  const disabled = new Set(preferences.disabled);
  return FIRST_PARTY_EXTENSIONS
    .filter((descriptor) => descriptor.profiles.includes(profile) && (descriptor.required || !disabled.has(descriptor.id)))
    .map(firstPartyExtensionPath);
}

export function firstPartyExtensionPaths(profile: "normal" | "device-control"): string[] {
  return FIRST_PARTY_EXTENSIONS
    .filter((descriptor) => descriptor.profiles.includes(profile))
    .map(firstPartyExtensionPath);
}

function inventoryName(extension: Extension, firstParty?: FirstPartyExtensionDescriptor): string {
  if (firstParty) return firstParty.name;
  const fileName = basename(extension.resolvedPath);
  return fileName.replace(/\.(?:[cm]?[jt]s)$/i, "") || fileName;
}

export function buildExtensionInventory(
  extensions: readonly Extension[],
  preferences = readExtensionPreferences(),
): ExtensionInventoryItem[] {
  return extensions.map((extension) => {
    const firstParty = getFirstPartyExtensionByPath(extension.resolvedPath);
    return {
      id: extensionId(extension),
      name: inventoryName(extension, firstParty),
      ...(firstParty?.description ? { description: firstParty.description } : {}),
      path: extension.resolvedPath,
      source: firstParty ? "piora" : extension.sourceInfo.source,
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      builtIn: Boolean(firstParty),
      required: firstParty?.required === true,
      enabled: isExtensionEnabled(extension, preferences),
      tools: [...extension.tools.keys()].sort(),
      commands: [...extension.commands.keys()].sort(),
      configurable: firstParty?.required !== true,
    };
  }).sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name));
}

export interface ResolvedExtensionCandidate {
  id: string;
  path: string;
  metadata: PathMetadata;
  builtIn: boolean;
  required: boolean;
  description?: string;
  name: string;
  enabled: boolean;
  configurable: boolean;
}

export interface ExtensionLoadPlan {
  candidates: ResolvedExtensionCandidate[];
  enabledPaths: string[];
  metadataByPath: Map<string, PathMetadata>;
}

export async function resolveExtensionLoadPlan(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  profile: "normal" | "device-control";
  installMissing?: boolean;
  preferences?: ExtensionPreferences;
}): Promise<ExtensionLoadPlan> {
  const preferences = options.preferences ?? readExtensionPreferences();
  const packageManager = new DefaultPackageManager(options);
  const resolved = await packageManager.resolve(options.installMissing ? undefined : async () => "skip");
  const candidates: ResolvedExtensionCandidate[] = [];

  for (const descriptor of FIRST_PARTY_EXTENSIONS.filter(({ profiles }) => profiles.includes(options.profile))) {
    const path = firstPartyExtensionPath(descriptor);
    if (!existsSync(path)) continue;
    candidates.push({
      id: descriptor.id,
      path,
      metadata: { source: "piora", scope: "temporary", origin: "top-level", baseDir: dirname(path) },
      builtIn: true,
      required: descriptor.required === true,
      description: descriptor.description,
      name: descriptor.name,
      enabled: isExtensionIdEnabled(descriptor.id, preferences),
      configurable: descriptor.required !== true,
    });
  }

  for (const resource of options.profile === "normal" ? resolved.extensions : []) {
    const id = extensionIdFromSource(resource.path, resource.metadata);
    candidates.push({
      id,
      path: resource.path,
      metadata: resource.metadata,
      builtIn: false,
      required: false,
      name: basename(resource.path).replace(/\.(?:[cm]?[jt]s)$/i, "") || basename(resource.path),
      enabled: resource.enabled && isExtensionIdEnabled(id, preferences),
      configurable: resource.enabled,
    });
  }

  const deduped = new Map<string, ResolvedExtensionCandidate>();
  for (const candidate of candidates) {
    const key = normalizedPath(candidate.path);
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  const unique = [...deduped.values()];
  return {
    candidates: unique,
    enabledPaths: unique.filter(({ enabled }) => enabled).map(({ path }) => path),
    metadataByPath: new Map(unique.map(({ path, metadata }) => [normalizedPath(path), metadata])),
  };
}

export function applyExtensionLoadPlan(
  result: LoadExtensionsResult,
  plan: ExtensionLoadPlan,
): LoadExtensionsResult {
  for (const extension of result.extensions) {
    const metadata = plan.metadataByPath.get(normalizedPath(extension.resolvedPath));
    if (!metadata) continue;
    extension.sourceInfo = {
      path: extension.resolvedPath,
      source: metadata.source,
      scope: metadata.scope,
      origin: metadata.origin,
      ...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
    };
  }
  return result;
}

/** Refresh discovery before the SDK reloads resources and clears its module cache. */
export function installExtensionLoadPlanReload(
  loader: ResourceLoader,
  plan: ExtensionLoadPlan,
  resolvePlan: () => Promise<ExtensionLoadPlan>,
): void {
  const reload = loader.reload.bind(loader);
  loader.reload = async (options) => {
    const next = await resolvePlan();
    // DefaultResourceLoader retains the supplied additionalExtensionPaths array.
    // Keep that array and the metadata closure live without touching SDK internals.
    plan.enabledPaths.splice(0, plan.enabledPaths.length, ...next.enabledPaths);
    plan.candidates = next.candidates;
    plan.metadataByPath = next.metadataByPath;
    await reload(options);
  };
}

export function buildExtensionInventoryFromPlan(
  plan: ExtensionLoadPlan,
  loaded: readonly Extension[],
): ExtensionInventoryItem[] {
  const loadedByPath = new Map(loaded.map((extension) => [normalizedPath(extension.resolvedPath), extension]));
  return plan.candidates.map((candidate) => {
    const extension = loadedByPath.get(normalizedPath(candidate.path));
    return {
      id: candidate.id,
      name: extension ? inventoryName(extension, getFirstPartyExtensionByPath(extension.resolvedPath)) : candidate.name,
      ...(candidate.description ? { description: candidate.description } : {}),
      path: candidate.path,
      source: candidate.metadata.source,
      scope: candidate.metadata.scope,
      origin: candidate.metadata.origin,
      builtIn: candidate.builtIn,
      required: candidate.required,
      enabled: candidate.enabled,
      tools: extension ? [...extension.tools.keys()].sort() : [],
      commands: extension ? [...extension.commands.keys()].sort() : [],
      configurable: candidate.configurable,
    };
  }).sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name));
}
