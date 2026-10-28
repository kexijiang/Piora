import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Read the authoritative active branch without creating an AgentSession.
 * SDK navigation can change only the live leaf until the next durable message. */
export async function intelligentUiSessionReader(sessionId: string, path: string): Promise<() => SessionManager> {
  const { getRpcSession } = await import("../rpc-manager");
  return () => {
    const live = getRpcSession(sessionId);
    return live?.isAlive() ? live.inner.sessionManager : SessionManager.open(path);
  };
}
