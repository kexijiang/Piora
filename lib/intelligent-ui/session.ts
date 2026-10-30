import { readOnlySessionManager, type ReadonlySessionManager } from "../session-readonly-manager";

/** Read the authoritative active branch without creating an AgentSession.
 * SDK navigation can change only the live leaf until the next durable message. */
export async function intelligentUiSessionReader(sessionId: string, path: string): Promise<() => ReadonlySessionManager> {
  const { getRpcSession } = await import("../rpc-manager");
  return () => {
    const live = getRpcSession(sessionId);
    return readOnlySessionManager(path, { expectedSessionId: sessionId,
      ...(live?.isAlive() ? { leafId: live.inner.sessionManager.getLeafId() } : {}) });
  };
}
