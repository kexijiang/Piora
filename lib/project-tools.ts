import {
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { getAgentRuntimeProfile, type AgentRuntimeProfile } from "./agent-runtime-profile";
import { applyExtensionLoadPlan, resolveExtensionLoadPlan } from "./extension-config";
import type { ToolInfo } from "./pi-types";
import {
  buildSessionCapabilitiesState,
  buildSessionCapabilityCatalog,
  createSessionCapabilityPolicy,
  resolveSessionCapabilityToolNames,
  type SessionCapabilitiesState,
  type SessionCapabilitySelection, type SessionCapabilityItem,
} from "./session-capabilities";
import {
  projectToolSelection, projectToolPolicyHistory,
  readProjectToolSettings,
  type ProjectToolSettingsRecord,
} from "./project-tool-settings";
import { getLiveProjectNativeMcpCatalog } from "./rpc-manager";
import { BUILTIN_AGENT_TOOLS } from "./tool-presets";
import { resolveProject } from "./worktree";
import { inspectToolRuntime, type ToolRuntimeInfo } from "./tool-runtime";

export interface ProjectToolsContext {
  projectRoot: string;
  profile: AgentRuntimeProfile;
  tools: ToolInfo[];
  capabilities: SessionCapabilitiesState;
  record: ProjectToolSettingsRecord | null;
  diagnostics: Array<{ path: string; error: string }>;
  runtime: ToolRuntimeInfo[];
  resources?: Array<Omit<SessionCapabilityItem, "enabled" | "activeToolNames">>;
}

function builtInToolDefinitions(cwd: string, profile: AgentRuntimeProfile): ToolInfo[] {
  if (profile !== "normal") return [];
  const allowed = new Set(BUILTIN_AGENT_TOOLS);
  const tools = [...createCodingTools(cwd), ...createReadOnlyTools(cwd)];
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function projectCatalog(tools: readonly ToolInfo[], profile: AgentRuntimeProfile, resources: NonNullable<ProjectToolsContext["resources"]>, record: ProjectToolSettingsRecord | null) {
  const catalog = [...buildSessionCapabilityCatalog(tools, profile), ...resources];
  if (profile === "normal" && record?.preset === "custom") {
    const current = new Set(catalog.map(item => item.id));
    for (const id of projectToolSelection(record).enabledCapabilityIds ?? []) if (!current.has(id)) catalog.push({
      id, label: id.startsWith("tool:") ? id.slice(5) : `MCP resources · ${id.slice(13)}`,
      description: "Previously selected capability; live discovery is unavailable.", kind: "extension", toolNames: id.startsWith("tool:") ? [id.slice(5)] : [], available: false, unavailableReason: "not_registered",
    });
  }
  return catalog;
}

export function buildProjectToolsCapabilities(
  tools: readonly ToolInfo[],
  profile: AgentRuntimeProfile,
  record: ProjectToolSettingsRecord | null,
  resources: NonNullable<ProjectToolsContext["resources"]> = [],
): SessionCapabilitiesState {
  const catalog = projectCatalog(tools, profile, resources, record);
  const policy = createSessionCapabilityPolicy(
    record ? projectToolSelection(record) : undefined,
    catalog,
    profile,
    (record?.revision ?? 0) - 1,
    record ? projectToolPolicyHistory(record) : undefined,
  );
  const active = resolveSessionCapabilityToolNames(catalog, policy, tools.map((tool) => tool.name));
  return buildSessionCapabilitiesState(catalog, policy, active);
}

export function buildProjectToolSelectionState(
  context: Pick<ProjectToolsContext, "profile" | "tools" | "record" | "resources">,
  selection: SessionCapabilitySelection,
  revision: number,
): SessionCapabilitiesState {
  const catalog = projectCatalog(context.tools, context.profile, context.resources ?? [], context.record);
  const policy = createSessionCapabilityPolicy(selection, catalog, context.profile, revision - 1, context.record ? projectToolPolicyHistory(context.record) : undefined);
  const active = resolveSessionCapabilityToolNames(catalog, policy, context.tools.map((tool) => tool.name));
  return buildSessionCapabilitiesState(catalog, policy, active);
}

export async function loadProjectToolsContext(
  cwd: string,
  profile: AgentRuntimeProfile = getAgentRuntimeProfile(),
): Promise<ProjectToolsContext> {
  const projectRoot = (await resolveProject(cwd)).projectRoot;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(projectRoot, agentDir, { projectTrusted: true });
  const plan = await resolveExtensionLoadPlan({ cwd: projectRoot, agentDir, settingsManager, profile });
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir,
    settingsManager,
    additionalExtensionPaths: plan.enabledPaths,
    noExtensions: true,
    extensionsOverride: (result) => applyExtensionLoadPlan(result, plan),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const toolsByName = new Map<string, ToolInfo>();
  for (const tool of builtInToolDefinitions(projectRoot, profile)) toolsByName.set(tool.name, tool);
  for (const extension of loaded.extensions) {
    for (const registered of extension.tools.values()) {
      const definition = registered.definition;
      toolsByName.set(definition.name, {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        exposure: definition.exposure,
        ...(definition.promptGuidelines ? { promptGuidelines: definition.promptGuidelines } : {}),
      });
    }
  }
  const live = profile === "normal" ? getLiveProjectNativeMcpCatalog(projectRoot) : { tools: [], resources: [] };
  for (const tool of live.tools) toolsByName.set(tool.name, tool);
  const tools = [...toolsByName.values()];
  const record = readProjectToolSettings(projectRoot);
  return {
    projectRoot,
    profile,
    tools,
    capabilities: buildProjectToolsCapabilities(tools, profile, record, live.resources),
    resources: live.resources,
    record,
    diagnostics: loaded.errors,
    runtime: inspectToolRuntime(),
  };
}
