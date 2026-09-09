import { listAllSessions } from "@/lib/session-reader";
import { requireRemotePrincipal } from "@/lib/remote-control-auth";
import { idempotencyKey, readRemoteJson } from "@/lib/remote-control-request";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { findRemoteSessionCreation, grantRemoteCapabilitySession } from "@/lib/remote-control-store";
import { createSession, parseSessionThinkingLevel } from "@/lib/session-creation";

export const dynamic = "force-dynamic";

interface RemoteCreationResult {
  sessionId: string;
  cwd?: string;
  runtimeProfile?: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string;
  idempotent: boolean;
}

declare global {
  var __pioraRemoteSessionCreationLocks: Map<string, Promise<RemoteCreationResult>> | undefined;
}

function creationLocks(): Map<string, Promise<RemoteCreationResult>> {
  return globalThis.__pioraRemoteSessionCreationLocks ??= new Map();
}

function sessionLinks(request: Request, sessionId: string) {
  const base = new URL(`/api/remote/v1/sessions/${encodeURIComponent(sessionId)}`, request.url);
  return {
    state: new URL(`${base.pathname}/state`, request.url).toString(),
    history: new URL(`${base.pathname}/history`, request.url).toString(),
    messages: new URL(`${base.pathname}/messages`, request.url).toString(),
    events: new URL(`${base.pathname}/events`, request.url).toString(),
    tools: new URL(`${base.pathname}/tools`, request.url).toString(),
    abort: new URL(`${base.pathname}/abort`, request.url).toString(),
    steer: new URL(`${base.pathname}/steer`, request.url).toString(),
  };
}

export async function GET(request: Request) {
  try {
    const principal = requireRemotePrincipal(request, "session.state.read");
    const allowed = principal.allowedSessionIds;
    const sessions = (await listAllSessions())
      .filter((session) => allowed.has(session.id))
      .map((session) => ({ id: session.id, name: session.name, cwd: session.cwd, modified: session.modified, messageCount: session.messageCount }));
    return Response.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = requireRemotePrincipal(request, "session.create");
    const key = idempotencyKey(request);
    const body = await readRemoteJson(request);
    if (body.policy !== undefined && body.policy !== "notes" && body.policy !== "agent") throw new Error("Unknown remote session policy");
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd || cwd.length > 32_768) throw new Error("cwd is required.");
    if (body.runtimeProfile !== undefined) throw new Error("runtimeProfile is selected only at process startup.");

    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (Boolean(provider) !== Boolean(modelId)) throw new Error("provider and modelId must be provided together.");
    if (provider.length > 200 || modelId.length > 300) throw new Error("Model selection is too long.");
    const thinkingLevel = parseSessionThinkingLevel(body.thinkingLevel);
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    if (name && name.length > 200) throw new Error("Session name is too long.");

    const lockKey = `${principal.tokenId}:${key}`;
    const locks = creationLocks();
    const shared = locks.get(lockKey);
    const operation = shared ?? (async (): Promise<RemoteCreationResult> => {
      const existingSessionId = findRemoteSessionCreation(principal.tokenId, key);
      if (existingSessionId) return { sessionId: existingSessionId, idempotent: true };
      const created = await createSession({
        cwd,
        remotePolicy: body.policy === "notes" ? "notes" : "agent",
        ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(name ? { name } : {}),
      });
      await grantRemoteCapabilitySession(principal.tokenId, created.sessionId, key);
      return {
        sessionId: created.sessionId,
        cwd: created.cwd,
        runtimeProfile: created.runtimeProfile,
        model: created.model,
        thinkingLevel: created.thinkingLevel,
        idempotent: false,
      };
    })();
    if (!shared) {
      locks.set(lockKey, operation);
      void operation.finally(() => {
        if (locks.get(lockKey) === operation) locks.delete(lockKey);
      }).catch(() => undefined);
    }
    const result = await operation;
    const idempotent = Boolean(shared) || result.idempotent;
    return Response.json({
      ...result,
      idempotent,
      links: sessionLinks(request, result.sessionId),
    }, {
      status: idempotent ? 200 : 201,
      headers: {
        "Cache-Control": "no-store",
        Location: new URL(`/api/remote/v1/sessions/${encodeURIComponent(result.sessionId)}/state`, request.url).toString(),
      },
    });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
