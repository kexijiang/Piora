import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  resolveSessionPath,
} from "@/lib/session-reader";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { runSessionFileOperation } from "@/lib/session-mutation";
import {
  bindSessionAgentRuntimeProfile,
  quarantineUnboundSessionFile,
  resolveSessionAgentRuntimeProfile,
} from "@/lib/agent-profile-store";
import {
  appendSessionCapabilityPolicy,
  copySessionCapabilityPolicy,
  readLatestSessionCapabilityPolicy,
} from "@/lib/session-capabilities";
import {
  appendSessionSystemPromptBinding,
  copySessionSystemPromptBinding,
  createSessionSystemPromptBinding,
  readLatestSessionSystemPromptBinding,
} from "@/lib/session-system-prompt";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const runtimeProfile = getAgentRuntimeProfile();
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    await resolveSessionAgentRuntimeProfile(id, runtimeProfile);
    return await runSessionFileOperation(id, async () => {
    const source = SessionManager.open(filePath);
    const leafId = source.getLeafId();
    if (!leafId) return NextResponse.json({ error: "Session is empty" }, { status: 409 });
    const duplicatedPath = source.createBranchedSession(leafId);
    if (!duplicatedPath) return NextResponse.json({ error: "Failed to duplicate session" }, { status: 500 });
    const duplicate = SessionManager.open(duplicatedPath);
    const newSessionId = duplicate.getSessionId();
    const sourceCapabilityPolicy = readLatestSessionCapabilityPolicy(source.getEntries());
    if (sourceCapabilityPolicy) {
      appendSessionCapabilityPolicy(duplicate, copySessionCapabilityPolicy(sourceCapabilityPolicy));
    }
    const sourceSystemPromptBinding = readLatestSessionSystemPromptBinding(source.getEntries())
      ?? createSessionSystemPromptBinding({ mode: "default" });
    appendSessionSystemPromptBinding(
      duplicate,
      copySessionSystemPromptBinding(sourceSystemPromptBinding),
    );
    invalidateSessionListCache();
    try {
      await bindSessionAgentRuntimeProfile(newSessionId, runtimeProfile);
    } catch (profileError) {
      quarantineUnboundSessionFile(duplicatedPath);
      invalidateSessionListCache();
      throw profileError;
    }
    const originalName = source.getSessionName();
    if (originalName) duplicate.appendSessionInfo(`${originalName} copy`);
    cacheSessionPath(newSessionId, duplicatedPath);
    invalidateSessionListCache();
    return NextResponse.json({ sessionId: newSessionId, runtimeProfile });
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
