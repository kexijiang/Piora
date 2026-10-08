import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { ExtensionInventoryItem, ExtensionsResponse } from "./extension-config";

export type { ExtensionInventoryItem, ExtensionsResponse };

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  sourceId?: string;
  skillId?: string;
  installId?: string;
  sourceUrl?: string;
  pinned?: boolean;
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export type McpCapabilityStatus = "disabled" | "configured" | "cached" | "stale";
export type McpTransportKind = "stdio" | "http" | "socket" | "unknown";

export interface McpToolCapability {
  name: string;
  description?: string;
}

export interface McpServerCapability {
  name: string;
  source: string;
  transport: McpTransportKind;
  status: McpCapabilityStatus;
  tools: McpToolCapability[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  cachedAt?: string;
}

export interface McpCapabilitiesInfo {
  serverCount: number;
  enabledServerCount: number;
  discoveredToolCount: number;
  setupPath: string;
  servers: McpServerCapability[];
  diagnostics: string[];
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
  mcpCapabilities?: McpCapabilitiesInfo;
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}
