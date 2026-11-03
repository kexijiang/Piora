import { NextResponse } from "next/server";
import { copyAnswerOutputState } from "@/lib/answer-output-server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openOwnedSessionManager } from "@/lib/session-owned-manager";
import { createSessionForkPublication } from "@/lib/session-fork-publication";
import { persistLazySessionManager } from "@/lib/session-persistence";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";
import { readDefaultToolPermission, writeToolPermission } from "@/lib/tool-permission-store";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  resolveSessionPath,
} from "@/lib/session-reader";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { runSessionFileOperation, drainSessionShutdown } from "@/lib/session-mutation";
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
    await drainSessionShutdown(id);
    const publication = createSessionForkPublication(filePath);
    let owned: ReturnType<typeof openOwnedSessionManager> | undefined;
    try {
    owned = openOwnedSessionManager(filePath, publication.stagingDir);
    const source = owned.manager;
    const leafId = source.getLeafId();
    if (!leafId) return NextResponse.json({ error: "Session is empty" }, { status: 409 });
    const duplicatedPath = source.createBranchedSession(leafId);
    if (!duplicatedPath) return NextResponse.json({ error: "Failed to duplicate session" }, { status: 500 });
    owned.assertOwned();
    persistLazySessionManager(source);
    const duplicate = source;
    const newSessionId = duplicate.getSessionId();
    try {
      await copyAnswerOutputState(id, newSessionId, duplicate.getBranch().map(entry => entry.id), {
        sourceFile: filePath, targetFile: duplicatedPath, sourceLeafId: leafId,
      });
    } catch (error) {
      owned.assertOwned();
      quarantineUnboundSessionFile(duplicatedPath);
      throw error;
    }
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
    try {
      writeToolPermission(newSessionId, readDefaultToolPermission(getAgentDir()), getAgentDir());
      await bindSessionAgentRuntimeProfile(newSessionId, runtimeProfile);
    } catch (profileError) {
      owned.assertOwned();
      quarantineUnboundSessionFile(duplicatedPath);
      invalidateSessionListCache();
      throw profileError;
    }
    const originalName = source.getSessionName();
    if (originalName) duplicate.appendSessionInfo(`${originalName} copy`);
    const publishedPath = publication.publish(owned);
    cacheSessionPath(newSessionId, publishedPath);
    invalidateSessionListCache();
    return NextResponse.json({ sessionId: newSessionId, runtimeProfile });
    } finally {
      try { publication.dispose(owned); } finally { owned?.release(); }
    }
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: isSessionOwnershipError(error) ? 409 : 500 });
  }
}
