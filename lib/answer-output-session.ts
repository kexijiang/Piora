import { readOnlySessionManager, type ReadonlySessionManager } from "./session-readonly-manager";

/** Honor live SDK navigation without constructing a new AgentSession. */
export async function answerOutputSessionReader(sessionId: string, path: string): Promise<() => ReadonlySessionManager> {
  const { getRpcSession } = await import("./rpc-manager");
  return () => {
    const live = getRpcSession(sessionId);
    return readOnlySessionManager(path, { expectedSessionId: sessionId,
      ...(live?.isAlive() ? { leafId: live.inner.sessionManager.getLeafId() } : {}) });
  };
}
