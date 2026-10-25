import { commandOperationView } from "@/lib/chat-command-events";
import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveOrStartRpcSession } from "@/lib/session-runtime-resolver";
import { resolveSessionPath } from "@/lib/session-reader";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { resolveSessionAgentRuntimeProfile } from "@/lib/agent-profile-store";
import { getSessionMessageRouter, SessionMessageRouterError } from "@/lib/session-message-router";
import type { SessionCommandStatus } from "@/lib/session-message-types";
import { randomUUID } from "node:crypto";
import { dispatchChatInput, ChatInputDispatchError } from "@/lib/chat-input-dispatch";

function messageIdempotency(id: string, body: Record<string, unknown>): string {
  return typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : `ui:${id}:${randomUUID()}`;
}

function errorStatus(error: unknown): number {
  if (error instanceof SessionMessageRouterError) {
    if (["SESSION_NOT_FOUND", "SESSION_FILE_INVALID", "COMMAND_NOT_FOUND"].includes(error.code)) return 404;
    if (["SESSION_BUSY", "STEER_REQUIRES_RUNNING_SESSION", "SESSION_QUEUE_FULL"].includes(error.code)) return 409;
    if (error.code === "SESSION_MESSAGE_TOO_LARGE") return 413;
    if (["INVALID_SESSION_MESSAGE", "COMMAND_EXPIRED"].includes(error.code)) return 400;
  }
  return 500;
}

const promptCommandStatuses = new Set<SessionCommandStatus>([
  "accepted", "queued", "dispatching", "delivered", "running",
  "completed", "failed", "cancelled", "expired", "interrupted",
]);
const promptCommandIdPattern = /^cmd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readPromptCommandState(sessionId: string, commandId: string) {
  try {
    const command = await getSessionMessageRouter().getCommand(commandId);
    // Router records describe a full prompt by next_turn delivery. Steer and
    // follow-up records use steer delivery and must not settle this prompt.
    if (command.commandId !== commandId || command.targetSessionId !== sessionId
      || command.delivery !== "next_turn" || !promptCommandStatuses.has(command.status)) return null;
    return { commandId: command.commandId, status: command.status };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "COMMAND_NOT_FOUND") return null;
    throw new Error("Prompt command state is unavailable.");
  }
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const runtimeProfile = getAgentRuntimeProfile();
    const body = await req.json() as { type: string; [key: string]: unknown };
    if (body.type === "recall_queued_inputs") {
      const records = await getSessionMessageRouter().recallQueuedInputs(id);
      return NextResponse.json({ success: true, data: records.map(commandOperationView) });
    }
    if (body.type === "queued_input_action") {
      if (typeof body.commandId !== "string" || !promptCommandIdPattern.test(body.commandId) || !["pause", "resume", "edit", "steer", "cancel"].includes(String(body.action)) || (body.text !== undefined && typeof body.text !== "string") || (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0))) return NextResponse.json({ error: "Invalid queue action", code: "INVALID_SESSION_MESSAGE" }, { status: 400 });
      const record = await getSessionMessageRouter().queuedInputAction(id, body.commandId, body.action as "pause" | "resume" | "edit" | "steer" | "cancel", body.text as string | undefined, typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
      return NextResponse.json({ success: true, data: commandOperationView(record) });
    }
    if (body.type === "submit_input") {
      const result = await dispatchChatInput(id, body);
      return NextResponse.json({ success: true, data: result });
    }
    if (body.type === "read_command_client_action" || body.type === "confirm_command_client_action") {
      if (typeof body.commandId !== "string" || typeof body.requestId !== "string" || (body.type === "confirm_command_client_action" && typeof body.success !== "boolean")) return NextResponse.json({ error: "Invalid client action identity" }, { status: 400 });
      const router = getSessionMessageRouter();
      const result = body.type === "read_command_client_action" ? router.getClientAction(id, body.commandId, body.requestId)
        : router.confirmClientAction(id, body.commandId, body.requestId, body.success as boolean, typeof body.error === "string" ? body.error : undefined);
      return NextResponse.json({ success: true, data: result ?? null });
    }

    if (body.type === "cancel_prompt_submission") {
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      if (!idempotencyKey || idempotencyKey.length > 512
        || (body.promptCommandId !== undefined && (typeof body.promptCommandId !== "string"
          || !promptCommandIdPattern.test(body.promptCommandId)))) {
        return NextResponse.json({ error: "Invalid prompt cancellation identity.", code: "INVALID_SESSION_MESSAGE" }, { status: 400 });
      }
      const result = await getSessionMessageRouter().cancelPromptSubmission({
        targetSessionId: id,
        idempotencyKey,
        ...(typeof body.promptCommandId === "string" ? { promptCommandId: body.promptCommandId } : {}),
      });
      return NextResponse.json({ success: true, data: result });
    }

    if (body.type === "prompt" || body.type === "steer" || body.type === "follow_up") {
      const router = getSessionMessageRouter();
      const input = {
        targetSessionId: id,
        content: typeof body.message === "string" ? body.message : "",
        source: "ui" as const,
        idempotencyKey: messageIdempotency(id, body),
        ...(Array.isArray(body.images) ? { images: body.images } : {}),
        ...(Array.isArray(body.materials) ? { materials: body.materials as Array<{ id: string }> } : {}),
      };
      const result = body.type === "steer"
        ? await router.steerSession(input)
        : body.type === "follow_up" || body.streamingBehavior === "followUp"
          ? await router.followUpSession(input)
          : body.streamingBehavior === "steer"
            ? await router.steerSession(input)
            : await router.dispatchSessionMessage({ ...input, delivery: "next_turn" });
      return NextResponse.json({ success: true, data: result, commandId: result.commandId, ...(result.runId ? { runId: result.runId } : {}), ...(result.attachedRunId ? { attachedRunId: result.attachedRunId } : {}) });
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      await resolveSessionAgentRuntimeProfile(id, runtimeProfile);
      if (existing.runtimeProfile !== runtimeProfile) {
        throw new Error(`Live session ${id} has a mismatched runtime profile.`);
      }
      const result = await existing.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    const { session } = await resolveOrStartRpcSession(id, { runtimeProfile });
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ChatInputDispatchError) return NextResponse.json({ error: error.message, code: error.code, commandName: error.commandName }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), ...(error instanceof SessionMessageRouterError ? { code: error.code } : {}) }, { status: errorStatus(error) });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const commandIds = new URL(req.url).searchParams.getAll("promptCommandId");
  if (commandIds.length > 1 || (commandIds.length === 1
    && !promptCommandIdPattern.test(commandIds[0]))) {
    return NextResponse.json({ error: "Invalid promptCommandId.", code: "INVALID_PROMPT_COMMAND_ID" }, { status: 400 });
  }
  const commandId = commandIds[0];
  const commandState = async () => commandId ? { promptCommand: await readPromptCommandState(id, commandId) } : {};
  const responseOptions = commandId ? { headers: { "Cache-Control": "no-store" } } : undefined;

  try {
    const runtimeProfile = getAgentRuntimeProfile();
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return NextResponse.json({ running: false, runtimeProfile, ...await commandState() }, responseOptions);
      await resolveSessionAgentRuntimeProfile(id, runtimeProfile);
      return NextResponse.json({ running: false, runtimeProfile, ...await commandState() }, responseOptions);
    }

    await resolveSessionAgentRuntimeProfile(id, runtimeProfile);
    if (session.runtimeProfile !== runtimeProfile) {
      throw new Error(`Live session ${id} has a mismatched runtime profile.`);
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state, runtimeProfile, ...await commandState() }, responseOptions);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
