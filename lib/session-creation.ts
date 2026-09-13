import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { getAgentRuntimeProfile, type AgentRuntimeProfile } from "./agent-runtime-profile";
import { allowFileRoot } from "./file-access";
import { startRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { invalidateSessionListCache } from "./session-reader";
import type { SessionCapabilitiesState, SessionCapabilitySelection } from "./session-capabilities";
import type { SystemPromptSelection } from "./system-prompt-types";
import type { RemoteSessionReservation } from "./remote-session-creation";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseSessionThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

export interface CreateSessionInput {
  reservation?: RemoteSessionReservation;
  remotePolicy?: "agent" | "notes";
  cwd: string;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  toolNames?: string[];
  capabilitySelection?: SessionCapabilitySelection;
  systemPromptSelection?: SystemPromptSelection;
  name?: string;
  runtimeProfile?: AgentRuntimeProfile;
}

export interface CreatedSession {
  session: AgentSessionWrapper;
  sessionId: string;
  cwd: string;
  runtimeProfile: AgentRuntimeProfile;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  capabilities: SessionCapabilitiesState;
}

/** Shared creation boundary for the Piora UI and versioned remote API. */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const cwd = resolve(input.cwd);
  let isDirectory = false;
  try { isDirectory = statSync(cwd).isDirectory(); } catch { /* normalized below */ }
  if (!isDirectory) throw new Error(`Directory does not exist: ${cwd}`);

  const runtimeProfile = input.runtimeProfile ?? getAgentRuntimeProfile();
  const { session, realSessionId } = await startRpcSession(input.reservation?.sessionId ?? `__new__${randomUUID()}`, "", cwd, {
    ...(input.reservation ? { preparedSessionFile: input.reservation.sessionFile } : {}),
    ...(input.toolNames ? { toolNames: input.toolNames } : {}),
    ...(input.remotePolicy ? { remotePolicy: input.remotePolicy } : {}),
    ...(input.capabilitySelection ? { capabilitySelection: input.capabilitySelection } : {}),
    ...(input.systemPromptSelection ? { systemPromptSelection: input.systemPromptSelection } : {}),
    ...(input.initialModel ? { initialModel: input.initialModel } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    runtimeProfile,
  });
  try {
    if (input.name?.trim()) await session.send({ type: "set_session_name", name: input.name.trim().slice(0, 200) });
    if (input.remotePolicy) session.persistSessionFile();

    allowFileRoot(cwd);
    invalidateSessionListCache();
    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      capabilities: SessionCapabilitiesState;
    };
    return {
      session,
      sessionId: realSessionId,
      cwd,
      runtimeProfile,
      model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
      thinkingLevel: state.thinkingLevel ?? "off",
      capabilities: state.capabilities,
    };
  } catch (error) {
    // A failed post-start state read must not leave a live orphan behind. This
    // also makes the route's one retry safe for transient filesystem failures.
    session.destroy();
    throw error;
  }
}
