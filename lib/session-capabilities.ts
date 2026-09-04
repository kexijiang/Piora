import type { AgentRuntimeProfile } from "./agent-runtime-profile";
import { BUILTIN_AGENT_TOOLS, HARMONY_AGENT_TOOLS } from "./tool-presets";

export const SESSION_CAPABILITY_ENTRY_TYPE = "piora-session-capabilities";
export const SESSION_CAPABILITY_VERSION = 1 as const;

export type SessionCapabilityPreset = "chat" | "coding" | "research" | "device" | "custom";
export type SessionCapabilityKind = "workspace" | "browser" | "device" | "interaction" | "automation" | "collaboration" | "extension";

export interface SessionCapabilityPolicy {
  version: typeof SESSION_CAPABILITY_VERSION;
  revision: number;
  preset: SessionCapabilityPreset;
  enabledCapabilityIds: string[];
  knownCapabilityIds: string[];
  updatedAt: string;
}

export interface SessionCapabilityItem {
  id: string;
  label: string;
  description: string;
  kind: SessionCapabilityKind;
  toolNames: string[];
  available: boolean;
  unavailableReason?: "not_registered" | "profile_restricted";
  enabled: boolean;
  activeToolNames: string[];
}

export interface SessionCapabilitiesState {
  policy: SessionCapabilityPolicy;
  items: SessionCapabilityItem[];
  enabledCount: number;
  activeCount: number;
}

export interface SessionCapabilitySelection {
  preset: SessionCapabilityPreset;
  enabledCapabilityIds?: string[];
  expectedRevision?: number;
}

export interface SessionCapabilityEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface SessionCapabilityToolInfo {
  name: string;
  description: string;
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

interface CapabilityDefinition {
  legacyId: string;
  kind: Exclude<SessionCapabilityKind, "extension">;
  profiles: readonly AgentRuntimeProfile[];
  matches: (toolName: string) => boolean;
}

const BUILTIN_TOOL_SET = new Set(BUILTIN_AGENT_TOOLS);
const HARMONY_TOOL_SET = new Set(HARMONY_AGENT_TOOLS);

const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    legacyId: "workspace",
    kind: "workspace",
    profiles: ["normal"],
    matches: (name) => BUILTIN_TOOL_SET.has(name),
  },
  {
    legacyId: "browser",
    kind: "browser",
    profiles: ["normal"],
    matches: (name) => name === "browser",
  },
  {
    legacyId: "harmony",
    kind: "device",
    profiles: ["normal", "device-control"],
    matches: (name) => HARMONY_TOOL_SET.has(name),
  },
  {
    legacyId: "ask-user",
    kind: "interaction",
    profiles: ["normal"],
    matches: (name) => name === "piora_request_user_input",
  },
  {
    legacyId: "automations",
    kind: "automation",
    profiles: ["normal"],
    matches: (name) => name === "piora_automation",
  },
  {
    legacyId: "collaboration",
    kind: "collaboration",
    profiles: ["normal"],
    matches: (name) => name === "piora_room",
  },
] as const;

const PRESET_TOOL_NAMES: Record<Exclude<SessionCapabilityPreset, "custom">, ReadonlySet<string>> = {
  chat: new Set(),
  coding: new Set([...BUILTIN_AGENT_TOOLS, "browser"]),
  research: new Set(["browser"]),
  device: new Set(HARMONY_AGENT_TOOLS),
};

const TOOL_ORDER = new Map([
  ...BUILTIN_AGENT_TOOLS,
  "browser",
  "piora_request_user_input",
  "piora_automation",
  "piora_room",
  ...HARMONY_AGENT_TOOLS,
].map((name, index) => [name, index]));

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function humanizeToolName(name: string): string {
  return name
    .replace(/^piora_/, "")
    .replace(/^harmony_/, "Harmony · ")
    .split("_")
    .map((part) => part.length > 0 ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

export function buildSessionCapabilityCatalog(
  tools: readonly SessionCapabilityToolInfo[],
  profile: AgentRuntimeProfile,
): Array<Omit<SessionCapabilityItem, "enabled" | "activeToolNames">> {
  return tools
    .map((tool): Omit<SessionCapabilityItem, "enabled" | "activeToolNames"> => {
      const definition = CAPABILITY_DEFINITIONS.find((candidate) => candidate.matches(tool.name));
      const profileAllowed = definition?.profiles.includes(profile) ?? profile === "normal";
      return {
        id: `tool:${tool.name}`,
        label: humanizeToolName(tool.name),
        description: tool.description?.trim() || `Allow the model to call ${tool.name}.`,
        kind: definition?.kind ?? "extension",
        toolNames: [tool.name],
        available: profileAllowed,
        ...(!profileAllowed ? { unavailableReason: "profile_restricted" as const } : {}),
      };
    })
    .sort((left, right) => {
      const leftOrder = TOOL_ORDER.get(left.toolNames[0]) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = TOOL_ORDER.get(right.toolNames[0]) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.toolNames[0].localeCompare(right.toolNames[0]);
    });
}

function isPreset(value: unknown): value is SessionCapabilityPreset {
  return value === "chat" || value === "coding" || value === "research" || value === "device" || value === "custom";
}

function parsePolicy(value: unknown): SessionCapabilityPolicy | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<SessionCapabilityPolicy>;
  if (
    source.version !== SESSION_CAPABILITY_VERSION
    || !Number.isSafeInteger(source.revision)
    || Number(source.revision) < 0
    || !isPreset(source.preset)
    || !Array.isArray(source.enabledCapabilityIds)
    || !Array.isArray(source.knownCapabilityIds)
    || typeof source.updatedAt !== "string"
  ) return null;
  return {
    version: SESSION_CAPABILITY_VERSION,
    revision: Number(source.revision),
    preset: source.preset,
    enabledCapabilityIds: uniqueStrings(source.enabledCapabilityIds),
    knownCapabilityIds: uniqueStrings(source.knownCapabilityIds),
    updatedAt: source.updatedAt,
  };
}

export function readLatestSessionCapabilityPolicy(entries: readonly SessionCapabilityEntryLike[]): SessionCapabilityPolicy | null {
  let latest: SessionCapabilityPolicy | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SESSION_CAPABILITY_ENTRY_TYPE) continue;
    const policy = parsePolicy(entry.data);
    if (policy) latest = policy;
  }
  return latest;
}

export function defaultSessionCapabilityPreset(profile: AgentRuntimeProfile): SessionCapabilityPreset {
  return profile === "normal" ? "coding" : "custom";
}

function availableIds(catalog: readonly { id: string; available: boolean }[]): string[] {
  return catalog.filter((item) => item.available).map((item) => item.id);
}

export function createSessionCapabilityPolicy(
  selection: SessionCapabilitySelection | undefined,
  catalog: readonly { id: string; available: boolean; toolNames: string[] }[],
  profile: AgentRuntimeProfile,
  previousRevision = 0,
  previousPolicy?: SessionCapabilityPolicy | null,
): SessionCapabilityPolicy {
  const preset = selection?.preset ?? defaultSessionCapabilityPreset(profile);
  const catalogIds = new Set(catalog.map((item) => item.id));
  const previouslyKnownIds = new Set(previousPolicy?.knownCapabilityIds ?? []);
  const requestedIds = preset === "custom"
    ? selection?.enabledCapabilityIds ?? availableIds(catalog)
    : catalog
        .filter((item) => item.toolNames.some((name) => PRESET_TOOL_NAMES[preset].has(name)))
        .map((item) => item.id);
  const enabledCapabilityIds = uniqueStrings(requestedIds).filter((id) => catalogIds.has(id) || previouslyKnownIds.has(id));
  return {
    version: SESSION_CAPABILITY_VERSION,
    revision: previousRevision + 1,
    preset,
    enabledCapabilityIds,
    knownCapabilityIds: uniqueStrings([...catalogIds, ...previouslyKnownIds]),
    updatedAt: new Date().toISOString(),
  };
}

export function restoreSessionCapabilityPolicy(
  entries: readonly SessionCapabilityEntryLike[],
  catalog: readonly { id: string; available: boolean; kind: SessionCapabilityKind; toolNames: string[] }[],
  profile: AgentRuntimeProfile = "normal",
): SessionCapabilityPolicy {
  const restored = readLatestSessionCapabilityPolicy(entries);
  if (restored) {
    const enabledIds = new Set(restored.enabledCapabilityIds);
    const catalogIds = new Set(catalog.map((item) => item.id));
    const migratedIds = catalog
      .filter((item) => enabledIds.has(item.id) || CAPABILITY_DEFINITIONS.some((definition) => (
        definition.kind === item.kind && enabledIds.has(definition.legacyId)
      )))
      .map((item) => item.id);
    return {
      ...restored,
      preset: "custom",
      enabledCapabilityIds: uniqueStrings(migratedIds),
      knownCapabilityIds: uniqueStrings([...restored.knownCapabilityIds.filter((id) => catalogIds.has(id)), ...catalogIds]),
    };
  }
  return createSessionCapabilityPolicy(undefined, catalog, profile, -1);
}

export function copySessionCapabilityPolicy(policy: SessionCapabilityPolicy): SessionCapabilityPolicy {
  return {
    ...policy,
    revision: 1,
    enabledCapabilityIds: [...policy.enabledCapabilityIds],
    knownCapabilityIds: [...policy.knownCapabilityIds],
    updatedAt: new Date().toISOString(),
  };
}

export function resolveSessionCapabilityToolNames(
  catalog: readonly { id: string; available: boolean; toolNames: string[] }[],
  policy: SessionCapabilityPolicy,
  allToolNames: readonly string[],
  ceiling?: ReadonlySet<string>,
): string[] {
  const enabledIds = new Set(policy.enabledCapabilityIds);
  const allowed = new Set<string>();
  for (const item of catalog) {
    if (!item.available || !enabledIds.has(item.id)) continue;
    item.toolNames.forEach((name) => allowed.add(name));
  }
  const result = [...allowed].filter((name) => !ceiling || ceiling.has(name));
  return uniqueStrings(result);
}

export function buildSessionCapabilitiesState(
  catalog: ReadonlyArray<Omit<SessionCapabilityItem, "enabled" | "activeToolNames">>,
  policy: SessionCapabilityPolicy,
  activeToolNames: readonly string[],
): SessionCapabilitiesState {
  const enabledIds = new Set(policy.enabledCapabilityIds);
  const active = new Set(activeToolNames);
  const items = catalog.map((item): SessionCapabilityItem => ({
    ...item,
    toolNames: [...item.toolNames],
    enabled: enabledIds.has(item.id),
    activeToolNames: item.toolNames.filter((name) => active.has(name)),
  }));
  return {
    policy: {
      ...policy,
      enabledCapabilityIds: [...policy.enabledCapabilityIds],
      knownCapabilityIds: [...policy.knownCapabilityIds],
    },
    items,
    enabledCount: items.filter((item) => item.available && item.enabled).length,
    activeCount: items.filter((item) => item.activeToolNames.length > 0).length,
  };
}

export function selectionFromToolNames(
  toolNames: readonly string[],
  catalog: readonly { id: string; toolNames: string[] }[],
): SessionCapabilitySelection {
  const requested = new Set(toolNames);
  return {
    preset: "custom",
    enabledCapabilityIds: catalog
      .filter((item) => item.toolNames.some((name) => requested.has(name)))
      .map((item) => item.id),
  };
}

export function appendSessionCapabilityPolicy(
  sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => string },
  policy: SessionCapabilityPolicy,
): string {
  return sessionManager.appendCustomEntry(SESSION_CAPABILITY_ENTRY_TYPE, policy);
}

export function createDefaultSessionCapabilitiesState(
  profile: AgentRuntimeProfile = "normal",
): SessionCapabilitiesState {
  const toolNames = profile === "device-control"
    ? [...HARMONY_AGENT_TOOLS]
    : [
        ...BUILTIN_AGENT_TOOLS,
        "browser",
        ...HARMONY_AGENT_TOOLS,
        "piora_automation",
        "piora_room",
      ];
  const tools = uniqueStrings(toolNames).map((name) => ({ name, description: "" }));
  const catalog = buildSessionCapabilityCatalog(tools, profile);
  const policy = createSessionCapabilityPolicy(undefined, catalog, profile);
  const active = resolveSessionCapabilityToolNames(catalog, policy, toolNames);
  return buildSessionCapabilitiesState(catalog, policy, active);
}

export function applySessionCapabilitySelectionToState(
  state: SessionCapabilitiesState,
  selection: SessionCapabilitySelection,
  profile: AgentRuntimeProfile = "normal",
): SessionCapabilitiesState {
  const catalog = state.items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    kind: item.kind,
    toolNames: [...item.toolNames],
    available: item.available,
    ...(item.unavailableReason ? { unavailableReason: item.unavailableReason } : {}),
  }));
  const policy = createSessionCapabilityPolicy(
    selection,
    catalog,
    profile,
    state.policy.revision,
    state.policy,
  );
  const allToolNames = catalog.flatMap((item) => item.toolNames);
  const active = resolveSessionCapabilityToolNames(catalog, policy, allToolNames);
  return buildSessionCapabilitiesState(catalog, policy, active);
}
