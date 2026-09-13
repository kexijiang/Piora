import { authenticateRemoteCapabilityToken, touchRemoteCapabilityToken, readRemoteCapabilityStore, readRemoteServerId } from "./remote-control-store";
import type { RemoteCapabilityPrincipal, RemoteControlScope } from "./remote-control-types";
import { resolveRemoteCreationCwd } from "./remote-creation-policy";

export type RemoteAuthErrorCode =
  | "REMOTE_TOKEN_REQUIRED"
  | "REMOTE_TOKEN_EXPIRED"
  | "REMOTE_SCOPE_DENIED"
  | "SESSION_NOT_ALLOWED"
  | "REMOTE_CREATION_DENIED"
  | "REMOTE_SERVER_CHANGED"
  | "REMOTE_CAPABILITY_CHANGED"
  | "RATE_LIMITED";

export class RemoteControlAuthError extends Error {
  constructor(readonly code: RemoteAuthErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RemoteControlAuthError";
  }
}
declare global {
  var __pioraRemoteRateLimits: Map<string, { startedAt: number; count: number }> | undefined;
}

function rateLimits(): Map<string, { startedAt: number; count: number }> {
  return globalThis.__pioraRemoteRateLimits ??= new Map();
}

function assertRateLimit(tokenId: string, sessionId?: string): void {
  const key = `${tokenId}:${sessionId ?? "*"}`;
  const now = Date.now();
  const current = rateLimits().get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateLimits().set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= 120) throw new RemoteControlAuthError("RATE_LIMITED", "Remote request rate limit exceeded.", 60);
  current.count += 1;
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value ? /^Bearer\s+([^\s]+)$/i.exec(value) : null;
  return match?.[1];
}

function assertServerIdentity(expectedServerId: string): void {
  let actualServerId;
  try { actualServerId = readRemoteServerId(); } catch {}
  if (expectedServerId !== actualServerId) throw new RemoteControlAuthError("REMOTE_SERVER_CHANGED", "Remote server identity changed.");
}

export function requireRemotePrincipal(request: Request, scope: RemoteControlScope, sessionId?: string): RemoteCapabilityPrincipal {
  const expectedServerId = request.headers.get("x-piora-server-id");
  if (expectedServerId !== null) assertServerIdentity(expectedServerId);
  const token = bearerToken(request);
  if (!token) throw new RemoteControlAuthError("REMOTE_TOKEN_REQUIRED", "A remote capability token is required.");
  const record = authenticateRemoteCapabilityToken(token);
  if (!record) throw new RemoteControlAuthError("REMOTE_TOKEN_EXPIRED", "The remote capability token is invalid or expired.");
  const expectedCapabilityId = request.headers.get("x-piora-capability-id");
  if (expectedCapabilityId !== null && expectedCapabilityId !== record.id) throw new RemoteControlAuthError("REMOTE_CAPABILITY_CHANGED", "Remote capability identity changed.");
  assertRateLimit(record.id, sessionId);
  if (!record.scopes.includes(scope)) throw new RemoteControlAuthError("REMOTE_SCOPE_DENIED", "The remote capability does not grant this operation.");
  if (sessionId && !record.allowedSessionIds.includes(sessionId)) throw new RemoteControlAuthError("SESSION_NOT_ALLOWED", "The remote capability does not grant this Session.");
  void touchRemoteCapabilityToken(record.id);
  return {
    tokenId: record.id,
    ...(expectedServerId !== null ? { expectedServerId } : {}),
    scopes: new Set(record.scopes),
    allowedSessionIds: new Set(record.allowedSessionIds),
    allowedRoomIds: new Set(record.allowedRoomIds),
    ...(record.creationPolicy ? { creationPolicy: record.creationPolicy } : {}),
  };
}

export function remoteAuthErrorResponse(error: unknown): Response {
  if (error instanceof RemoteControlAuthError) {
    const status = error.code === "REMOTE_SERVER_CHANGED" || error.code === "REMOTE_CAPABILITY_CHANGED" ? 409 : error.code === "REMOTE_TOKEN_REQUIRED" || error.code === "REMOTE_TOKEN_EXPIRED" ? 401 : error.code === "RATE_LIMITED" ? 429 : 403;
    return Response.json({ error: error.message, code: error.code }, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {}),
      },
    });
  }
  return Response.json({ error: "Remote control request failed.", code: "REMOTE_CONTROL_ERROR" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export function resetRemoteAuthForTests(): void {
  globalThis.__pioraRemoteRateLimits?.clear();
}

function currentRemoteToken(principal: RemoteCapabilityPrincipal, scope: RemoteControlScope) {
  if (principal.expectedServerId !== undefined) assertServerIdentity(principal.expectedServerId);
  const token = readRemoteCapabilityStore().tokens.find(record => record.id === principal.tokenId);
  if (!token || token.revokedAt || (token.expiresAt !== undefined && token.expiresAt <= Date.now())) throw new RemoteControlAuthError("REMOTE_TOKEN_EXPIRED", "Remote capability expired or revoked");
  if (!token.scopes.includes(scope)) throw new RemoteControlAuthError("REMOTE_SCOPE_DENIED", "Scope was revoked");
  return token;
}
export function assertRemotePrincipalCurrent(principal: RemoteCapabilityPrincipal, scope: RemoteControlScope, sessionId: string): void {
  const token = currentRemoteToken(principal, scope);
  if (!token.allowedSessionIds.includes(sessionId)) throw new RemoteControlAuthError("SESSION_NOT_ALLOWED", "Session access was revoked");
}
export function authorizeRemoteCreation(principal: RemoteCapabilityPrincipal, mode: "notes" | "agent", cwd: string): string {
  const token = currentRemoteToken(principal, "session.create");
  try { return resolveRemoteCreationCwd(token.creationPolicy, mode, cwd); }
  catch { throw new RemoteControlAuthError("REMOTE_CREATION_DENIED", "The token does not allow this session policy or creation directory."); }
}
