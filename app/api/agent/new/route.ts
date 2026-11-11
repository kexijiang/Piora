import { NextResponse } from "next/server";
import { isPermissionMode } from "@/lib/tool-permission-policy";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { createSession, parseSessionThinkingLevel } from "@/lib/session-creation";
import type { SessionCapabilityPreset, SessionCapabilitySelection } from "@/lib/session-capabilities";
import type { SystemPromptSelection } from "@/lib/system-prompt-types";

type CreationErrorDetails = { status: number; code: string; message: string };

function hasRetryableFilesystemCode(error: unknown): boolean {
  const retryable = new Set(["EACCES", "EBUSY", "ELOCKED", "EMFILE", "ENFILE", "EPERM"]);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && retryable.has(String((current as NodeJS.ErrnoException).code ?? ""))) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function creationErrorDetails(error: unknown): CreationErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Directory does not exist:")) {
    return { status: 400, code: "SESSION_DIRECTORY_NOT_FOUND", message };
  }
  if (message.startsWith("Invalid thinking level:")) {
    return { status: 400, code: "INVALID_THINKING_LEVEL", message };
  }
  if (message.startsWith("Invalid session tool")) {
    return { status: 400, code: "INVALID_SESSION_TOOLS", message };
  }
  if (message.startsWith("Invalid enabled session tools")) {
    return { status: 400, code: "INVALID_SESSION_TOOLS", message };
  }
  if (message.startsWith("Invalid system prompt") || message.startsWith("System prompt template")) {
    return { status: 400, code: "INVALID_SYSTEM_PROMPT", message };
  }
  if (message.startsWith("Model is not available in the enabled scope:")) {
    return { status: 409, code: "MODEL_NOT_AVAILABLE", message };
  }
  if (hasRetryableFilesystemCode(error)) {
    return {
      status: 503,
      code: "SESSION_CREATION_RETRYABLE",
      message: "The session runtime is temporarily busy. Please try again.",
    };
  }
  return { status: 500, code: "SESSION_CREATION_FAILED", message };
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  try {
    const runtimeProfile = getAgentRuntimeProfile();
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    const permissionMode = command.permissionMode;
    delete command.permissionMode;
    if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
      return NextResponse.json({ error: "Invalid permission mode" }, { status: 400 });
    }

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, capabilitySelection: rawCapabilitySelection, systemPromptSelection: rawSystemPromptSelection, thinkingLevel, runtimeProfile: requestedRuntimeProfile, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; capabilitySelection?: unknown; systemPromptSelection?: unknown; thinkingLevel?: unknown; runtimeProfile?: unknown; [key: string]: unknown };
    if (requestedRuntimeProfile !== undefined) {
      return NextResponse.json({ error: "runtimeProfile is selected only at process startup" }, { status: 400 });
    }
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseSessionThinkingLevel(thinkingLevel);
    let capabilitySelection: SessionCapabilitySelection | undefined;
    if (rawCapabilitySelection !== undefined) {
      if (!rawCapabilitySelection || typeof rawCapabilitySelection !== "object") throw new Error("Invalid session tool selection.");
      const source = rawCapabilitySelection as { preset?: unknown; enabledCapabilityIds?: unknown };
      const validPresets: SessionCapabilityPreset[] = ["chat", "coding", "research", "device", "custom"];
      if (typeof source.preset !== "string" || !validPresets.includes(source.preset as SessionCapabilityPreset)) {
        throw new Error("Invalid session tool preset.");
      }
      if (source.enabledCapabilityIds !== undefined && !Array.isArray(source.enabledCapabilityIds)) {
        throw new Error("Invalid enabled session tools.");
      }
      capabilitySelection = {
        preset: source.preset as SessionCapabilityPreset,
        ...(Array.isArray(source.enabledCapabilityIds)
          ? { enabledCapabilityIds: source.enabledCapabilityIds.filter((id): id is string => typeof id === "string") }
          : {}),
      };
    }
    let systemPromptSelection: SystemPromptSelection | undefined;
    if (rawSystemPromptSelection !== undefined) {
      if (!rawSystemPromptSelection || typeof rawSystemPromptSelection !== "object") {
        throw new Error("Invalid system prompt selection.");
      }
      const selection = rawSystemPromptSelection as { mode?: unknown; templateId?: unknown };
      if (selection.mode === "default") {
        systemPromptSelection = { mode: "default" };
      } else if (selection.mode === "template" && typeof selection.templateId === "string") {
        systemPromptSelection = { mode: "template", templateId: selection.templateId };
      } else {
        throw new Error("Invalid system prompt selection.");
      }
    }
    const created = await createSession({
      cwd,
      ...(toolNames ? { toolNames } : {}),
      ...(capabilitySelection ? { capabilitySelection } : {}),
      ...(systemPromptSelection ? { systemPromptSelection } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      runtimeProfile,
    });
    const { session, sessionId: realSessionId } = created;
    const toolPermission = await session.send(permissionMode
      ? { type: "set_tool_permission", mode: permissionMode }
      : { type: "get_tool_permission" });

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: created.model,
        thinkingLevel: created.thinkingLevel,
        capabilities: created.capabilities,
        toolPermission,
        runtimeProfile,
      });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: created.model,
      thinkingLevel: created.thinkingLevel,
      runtimeProfile,
    });
  } catch (error) {
    const details = creationErrorDetails(error);
    if (details.status === 500) console.error("[pi-web] failed to create session:", error);
    return NextResponse.json(
      { error: details.message, code: details.code },
      { status: details.status },
    );
  }
}
