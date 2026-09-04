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
  type SessionCapabilitySelection,
} from "./session-capabilities";
import {
  projectToolSelection,
  readProjectToolSettings,
  type ProjectToolSettingsRecord,
} from "./project-tool-settings";
import { BUILTIN_AGENT_TOOLS } from "./tool-presets";
import { resolveProject } from "./worktree";

export interface ProjectToolsContext {
  projectRoot: string;
  profile: AgentRuntimeProfile;
  tools: ToolInfo[];
  capabilities: SessionCapabilitiesState;
  record: ProjectToolSettingsRecord | null;
  diagnostics: Array<{ path: string; error: string }>;
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

export function buildProjectToolsCapabilities(
  tools: readonly ToolInfo[],
  profile: AgentRuntimeProfile,
  record: ProjectToolSettingsRecord | null,
): SessionCapabilitiesState {
  const catalog = buildSessionCapabilityCatalog(tools, profile);
  const policy = createSessionCapabilityPolicy(
    record ? projectToolSelection(record) : undefined,
    catalog,
    profile,
    (record?.revision ?? 0) - 1,
  );
  const active = resolveSessionCapabilityToolNames(catalog, policy, tools.map((tool) => tool.name));
  return buildSessionCapabilitiesState(catalog, policy, active);
}

export function buildProjectToolSelectionState(
  context: Pick<ProjectToolsContext, "profile" | "tools" | "record">,
  selection: SessionCapabilitySelection,
  revision: number,
): SessionCapabilitiesState {
  const catalog = buildSessionCapabilityCatalog(context.tools, context.profile);
  const policy = createSessionCapabilityPolicy(selection, catalog, context.profile, revision - 1);
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
        ...(definition.promptGuidelines ? { promptGuidelines: definition.promptGuidelines } : {}),
      });
    }
  }
  const tools = [...toolsByName.values()];
  const record = readProjectToolSettings(projectRoot);
  return {
    projectRoot,
    profile,
    tools,
    capabilities: buildProjectToolsCapabilities(tools, profile, record),
    record,
    diagnostics: loaded.errors,
  };
}
