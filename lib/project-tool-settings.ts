import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { writePrivateFileAtomicSync } from "./atomic-file";
import type { SessionCapabilityPreset, SessionCapabilitySelection } from "./session-capabilities";

const PROJECT_TOOL_SETTINGS_VERSION = 1;
const MAX_PROJECT_TOOL_SETTINGS_BYTES = 1024 * 1024;
const MAX_PROJECT_RECORDS = 2_000;
const MAX_CAPABILITY_IDS = 512;

interface ProjectToolSettingsFile {
  version: typeof PROJECT_TOOL_SETTINGS_VERSION;
  projects: Record<string, ProjectToolSettingsRecord>;
}

export interface ProjectToolSettingsRecord {
  projectRoot: string;
  revision: number;
  preset: SessionCapabilityPreset;
  enabledCapabilityIds: string[];
  updatedAt: string;
}

export class ProjectToolSettingsConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super("Project tools changed in another view. Refresh and try again.");
    this.name = "ProjectToolSettingsConflictError";
  }
}

function isPreset(value: unknown): value is SessionCapabilityPreset {
  return value === "chat" || value === "coding" || value === "research" || value === "device" || value === "custom";
}

function normalizedProjectKey(projectRoot: string): string {
  const normalized = resolve(projectRoot).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptySettings(): ProjectToolSettingsFile {
  return { version: PROJECT_TOOL_SETTINGS_VERSION, projects: {} };
}

function parseRecord(value: unknown): ProjectToolSettingsRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ProjectToolSettingsRecord>;
  if (
    typeof source.projectRoot !== "string"
    || !Number.isSafeInteger(source.revision)
    || Number(source.revision) < 1
    || !isPreset(source.preset)
    || !Array.isArray(source.enabledCapabilityIds)
    || source.enabledCapabilityIds.length > MAX_CAPABILITY_IDS
    || typeof source.updatedAt !== "string"
  ) return null;
  const enabledCapabilityIds = [...new Set(source.enabledCapabilityIds.filter((id): id is string => (
    typeof id === "string" && id.startsWith("tool:") && id.length <= 260
  )))].sort();
  return {
    projectRoot: resolve(source.projectRoot),
    revision: Number(source.revision),
    preset: source.preset,
    enabledCapabilityIds,
    updatedAt: source.updatedAt,
  };
}

function readSettings(path: string): ProjectToolSettingsFile {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_PROJECT_TOOL_SETTINGS_BYTES) return emptySettings();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectToolSettingsFile>;
    if (parsed.version !== PROJECT_TOOL_SETTINGS_VERSION || !parsed.projects || typeof parsed.projects !== "object") {
      return emptySettings();
    }
    const projects: Record<string, ProjectToolSettingsRecord> = {};
    for (const [key, value] of Object.entries(parsed.projects).slice(0, MAX_PROJECT_RECORDS)) {
      const record = parseRecord(value);
      if (record && key === normalizedProjectKey(record.projectRoot)) projects[key] = record;
    }
    return { version: PROJECT_TOOL_SETTINGS_VERSION, projects };
  } catch {
    return emptySettings();
  }
}

export function projectToolSettingsPath(agentDir = getAgentDir()): string {
  return resolve(agentDir, "piora", "project-tools.json");
}

export function readProjectToolSettings(
  projectRoot: string,
  path = projectToolSettingsPath(),
): ProjectToolSettingsRecord | null {
  const record = readSettings(path).projects[normalizedProjectKey(projectRoot)];
  return record ? { ...record, enabledCapabilityIds: [...record.enabledCapabilityIds] } : null;
}

export function projectToolSelection(record: ProjectToolSettingsRecord): SessionCapabilitySelection {
  return {
    preset: record.preset,
    ...(record.preset === "custom" ? { enabledCapabilityIds: [...record.enabledCapabilityIds] } : {}),
  };
}

export function writeProjectToolSettings(
  projectRoot: string,
  selection: SessionCapabilitySelection,
  expectedRevision: number,
  path = projectToolSettingsPath(),
): ProjectToolSettingsRecord {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  if (!isPreset(selection.preset)) throw new TypeError("Invalid project tool preset");
  const enabledCapabilityIds = selection.preset === "custom"
    ? [...new Set((selection.enabledCapabilityIds ?? []).filter((id) => (
        typeof id === "string" && id.startsWith("tool:") && id.length <= 260
      )))].sort()
    : [];
  if (enabledCapabilityIds.length > MAX_CAPABILITY_IDS) throw new TypeError("Too many project tools selected");

  const settings = readSettings(path);
  const key = normalizedProjectKey(projectRoot);
  const currentRevision = settings.projects[key]?.revision ?? 0;
  if (currentRevision !== expectedRevision) throw new ProjectToolSettingsConflictError(currentRevision);
  if (!settings.projects[key] && Object.keys(settings.projects).length >= MAX_PROJECT_RECORDS) {
    throw new Error("Too many project tool settings records");
  }

  const record: ProjectToolSettingsRecord = {
    projectRoot: resolve(projectRoot),
    revision: currentRevision + 1,
    preset: selection.preset,
    enabledCapabilityIds,
    updatedAt: new Date().toISOString(),
  };
  settings.projects[key] = record;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { ...record, enabledCapabilityIds: [...record.enabledCapabilityIds] };
}
