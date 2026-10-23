import { TeamError } from "./team-errors";
import {
  TEAM_AGENT_PROFILE_SCHEMA_VERSION,
  TEAM_DEFAULTS,
  type TeamAgentProfile,
  type TeamAgentRole,
} from "./team-types";

const ROLE_PROMPTS: Record<TeamAgentRole, string> = {
  coordinator: `
Own the team's top-level objective from planning through verified delivery.
Create a dependency-valid plan, delegate work to the best qualified agents,
monitor structured task state, resolve blockers, and synthesize the final result.
Do not mark worker tasks complete yourself and do not bypass required reviews.
Use submit_plan, replan, and complete_run for state changes; prose is not state.
`.trim(),
  planner: `
Turn the objective into a minimal dependency-valid task graph with explicit
acceptance criteria, required capabilities, review policy, and integration work.
Do not modify the workspace and do not claim execution is complete.
Submit the plan only through submit_plan.
`.trim(),
  worker: `
Execute only the currently leased task in the assigned workspace. Keep changes
scoped, report progress, attach runtime-backed verification and artifacts, and
submit through submit_task. Never claim the TeamRun is complete.
`.trim(),
  reviewer: `
Independently verify the submission against its acceptance criteria. Inspect
evidence and artifacts, report concrete findings, and return exactly approved
or changes_requested through submit_review. Do not silently repair worker code.
`.trim(),
  participant: "Collaborate on explicitly assigned work and use structured team tools for all state changes.",
};

const CAPABILITIES: Record<TeamAgentRole, string[]> = {
  coordinator: ["planning", "delegation", "synthesis", "conflict-resolution"],
  planner: ["requirements-analysis", "architecture", "task-decomposition"],
  worker: ["implementation", "testing", "debugging"],
  reviewer: ["code-review", "verification", "risk-analysis"],
  participant: [],
};

const ROLE_DESCRIPTIONS: Record<TeamAgentRole, string> = {
  coordinator: "Owns planning, delegation, verified delivery, and final synthesis.",
  planner: "Produces dependency-valid structured plans without changing the workspace.",
  worker: "Implements and verifies the currently leased task.",
  reviewer: "Independently reviews evidence and submissions.",
  participant: "Contributes when explicitly assigned or invited.",
};

/** A conversational identity; workflow roles are an independent, opt-in concern. */
export function createRoomChatProfile(input: Partial<TeamAgentProfile> = {}): TeamAgentProfile {
  return createTeamAgentProfile(input.role ?? "participant", {
    ...input,
    roleDescription: input.roleDescription ?? "",
    systemPrompt: input.systemPrompt ?? "",
    capabilities: input.capabilities ?? [],
    toolPolicy: input.toolPolicy ?? { mode: "inherit" },
    workspacePolicy: input.workspacePolicy ?? { mode: "shared", integration: "artifact_only" },
  });
}

export function createTeamAgentProfile(role: TeamAgentRole, input: Partial<TeamAgentProfile> = {}): TeamAgentProfile {
  if (!Object.hasOwn(ROLE_PROMPTS, role)) throw new TeamError("TEAM_INVALID_INPUT", "Invalid Team Agent role.");
  const readOnly = role === "planner";
  const dedicated = role === "worker" || role === "reviewer";
  return validateTeamAgentProfile({
    schemaVersion: TEAM_AGENT_PROFILE_SCHEMA_VERSION,
    revision: 1,
    name: input.name?.trim() || role[0]!.toUpperCase() + role.slice(1),
    role,
    roleDescription: input.roleDescription ?? ROLE_DESCRIPTIONS[role],
    systemPrompt: input.systemPrompt ?? ROLE_PROMPTS[role],
    personality: input.personality ?? [],
    capabilities: input.capabilities ?? CAPABILITIES[role],
    constraints: input.constraints ?? [],
    modelPolicy: input.modelPolicy ?? { mode: "session" },
    toolPolicy: input.toolPolicy ?? (role === "planner"
      ? { mode: "allowlist", toolNames: ["read", "grep", "find", "ls", "piora_room"] }
      : role === "reviewer"
        ? { mode: "allowlist", toolNames: ["read", "grep", "find", "ls", "bash", "piora_room"] }
        : { mode: "inherit" }),
    skillPolicy: input.skillPolicy ?? { mode: "inherit" },
    workspacePolicy: input.workspacePolicy ?? {
      mode: readOnly ? "read_only" : dedicated ? "dedicated_worktree" : "shared",
      integration: role === "coordinator" ? "coordinator_integrates" : "artifact_only",
    },
    memoryPolicy: input.memoryPolicy ?? {
      recentRoomMessages: TEAM_DEFAULTS.recentRoomMessages,
      includePrivateNotes: false,
      retainAcrossRuns: true,
    },
  });
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TeamError("TEAM_INVALID_INPUT", `${label} must be text.`);
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw new TeamError("TEAM_INPUT_TOO_LARGE", `${label} is too long.`);
  return cleaned;
}

function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TeamError("TEAM_INVALID_INPUT", `${label} has an invalid item count.`);
  return [...new Set(value.map((item) => text(item, label, maxLength)).filter(Boolean))];
}

export function normalizeCapability(value: string): string {
  const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(slug)) throw new TeamError("TEAM_INVALID_INPUT", `Invalid capability: ${value}.`);
  return slug;
}

export function validateTeamAgentProfile(value: TeamAgentProfile): TeamAgentProfile {
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 1) {
    throw new TeamError("TEAM_INVALID_INPUT", "Invalid Team Agent profile revision.");
  }
  if (!["coordinator", "planner", "worker", "reviewer", "participant"].includes(value.role)) {
    throw new TeamError("TEAM_INVALID_INPUT", "Invalid Team Agent role.");
  }
  const profile = structuredClone(value);
  profile.name = text(profile.name, "Agent name", 120);
  if (!profile.name) throw new TeamError("TEAM_INVALID_INPUT", "Agent name must not be empty.");
  profile.roleDescription = text(profile.roleDescription, "Role description", 4_000);
  profile.systemPrompt = text(profile.systemPrompt, "Agent system prompt", 12_000);
  if (/\[PIORA TEAM|leaseToken/i.test(profile.systemPrompt)) {
    throw new TeamError("TEAM_INVALID_INPUT", "Agent system prompt contains a reserved Piora Team marker.");
  }
  profile.personality = stringList(profile.personality, "Personality", 32, 500);
  profile.constraints = stringList(profile.constraints, "Constraint", 32, 500);
  if (/\[PIORA TEAM|leaseToken/i.test([profile.roleDescription, ...profile.personality, ...profile.constraints].join("\n"))) {
    throw new TeamError("TEAM_INVALID_INPUT", "Agent profile contains a reserved Piora Team marker.");
  }
  profile.capabilities = stringList(profile.capabilities, "Capability", 64, 80).map(normalizeCapability);
  if (profile.modelPolicy.mode === "pinned") {
    profile.modelPolicy.provider = text(profile.modelPolicy.provider, "Model provider", 120);
    profile.modelPolicy.modelId = text(profile.modelPolicy.modelId, "Model id", 240);
  }
  if (profile.toolPolicy.mode === "allowlist") {
    profile.toolPolicy.toolNames = stringList(profile.toolPolicy.toolNames, "Tool name", 128, 120);
    if (!profile.toolPolicy.toolNames.includes("piora_room")) profile.toolPolicy.toolNames.push("piora_room");
  }
  if (profile.skillPolicy.mode === "allowlist") profile.skillPolicy.skillNames = stringList(profile.skillPolicy.skillNames, "Skill name", 128, 240);
  profile.memoryPolicy.recentRoomMessages = Math.max(0, Math.min(100, Math.floor(profile.memoryPolicy.recentRoomMessages)));
  return profile;
}

export function getTeamRolePrompt(role: TeamAgentRole): string {
  return ROLE_PROMPTS[role];
}
