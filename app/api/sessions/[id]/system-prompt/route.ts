import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";

import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { resolveSessionAgentRuntimeProfile } from "@/lib/agent-profile-store";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  appendSessionSystemPromptBinding,
  createSessionSystemPromptBinding,
  readLatestSessionSystemPromptBinding,
  selectionForSessionSystemPromptBinding,
} from "@/lib/session-system-prompt";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import type { SystemPromptSelection } from "@/lib/system-prompt-types";
import { runSessionFileOperation, drainSessionShutdown } from "@/lib/session-mutation";
import { openOwnedSessionManager } from "@/lib/session-owned-manager";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";

function parseSelection(value: unknown): SystemPromptSelection {
  if (!value || typeof value !== "object") throw new Error("Invalid system prompt selection.");
  const source = value as { mode?: unknown; templateId?: unknown };
  if (source.mode === "default") return { mode: "default" };
  if (source.mode === "template" && typeof source.templateId === "string") {
    return { mode: "template", templateId: source.templateId };
  }
  throw new Error("Invalid system prompt selection.");
}

async function readBinding(id: string) {
  const live = getRpcSession(id);
  if (live?.isAlive()) return live.getSystemPromptBinding();
  const filePath = await resolveSessionPath(id);
  if (!filePath) return undefined;
  return readLatestSessionSystemPromptBinding(SessionManager.open(filePath).getEntries());
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const binding = await readBinding(id);
    if (binding === undefined) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json({ binding, selection: selectionForSessionSystemPromptBinding(binding) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const runtimeProfile = getAgentRuntimeProfile();
    if (runtimeProfile !== "normal") {
      return NextResponse.json({ error: "System prompt templates are available only for normal sessions." }, { status: 409 });
    }
    const body = await request.json() as { selection?: unknown };
    const selection = parseSelection(body.selection);
    return await runSessionFileOperation(id, async () => {
    await drainSessionShutdown(id);
    const live = getRpcSession(id);
    if (live?.isAlive()) {
      if (live.isRunning()) return NextResponse.json({ error: "Wait for the current task to finish before changing the system prompt." }, { status: 409 });
      const binding = await live.setSystemPromptBinding(selection);
      const state = await live.send({ type: "get_state" }) as { systemPrompt?: string };
      return NextResponse.json({
        binding,
        selection: selectionForSessionSystemPromptBinding(binding),
        systemPrompt: state.systemPrompt ?? null,
      });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    await resolveSessionAgentRuntimeProfile(id, runtimeProfile);
    const owned = openOwnedSessionManager(filePath);
    try {
    const manager = owned.manager;
    const previous = readLatestSessionSystemPromptBinding(manager.getEntries());
    const binding = createSessionSystemPromptBinding(selection, undefined, previous);
    appendSessionSystemPromptBinding(manager, binding);
    invalidateSessionListCache();
    return NextResponse.json({ binding, selection: selectionForSessionSystemPromptBinding(binding) });
    } finally { owned.release(); }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: isSessionOwnershipError(error) ? 409 : 400 });
  }
}
