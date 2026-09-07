import { getRpcSession } from "./rpc-manager";
import { getActivePromptRun, getActivePromptRunStartedAt } from "./prompt-run-registry";
import { getActiveTeamPromptContext } from "./team-prompt-context";
import { getRoom } from "./room-store";
import { projectRoomActivity, type RoomActivity } from "./room-activity";

/** A room has one multiplexed feed. Observing never starts an AgentSession. */
export function subscribeRoomActivity(roomId: string, send: (activities: RoomActivity[]) => void): () => void {
  const entries = new Map<string, RoomActivity>();
  const subscriptions = new Map<string, { session: NonNullable<ReturnType<typeof getRpcSession>>; off: () => void }>();
  let previous = "";
  let closed = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (closed) return;
    const room = getRoom(roomId);
    const members = new Set(room.members.map((member) => member.binding.sessionId));
    for (const [id, item] of subscriptions) {
      if (!members.has(id) || getRpcSession(id) !== item.session || !item.session.isAlive()) { item.off(); subscriptions.delete(id); }
    }
    for (const id of entries.keys()) if (!members.has(id)) entries.delete(id);
    for (const id of members) {
      const session = getRpcSession(id);
      if (session?.isAlive() && !subscriptions.has(id)) {
        subscriptions.set(id, { session, off: session.onEvent((event) => {
          // Capture the last message before prompt cleanup removes its room context.
          if (event.type === "message_end") { tick(); return; }
          scheduled ??= setTimeout(() => { scheduled = undefined; tick(); }, 100);
        }) });
      }
      const prompt = getActivePromptRun(id);
      const belongs = prompt && (prompt.roomContext?.roomId === roomId || getActiveTeamPromptContext(id)?.roomId === roomId);
      if (session?.isAlive() && belongs) {
        const state = session.inner.agent.state;
        const next = projectRoomActivity({ sessionId: id, runId: prompt.runId, messages: state?.messages ?? [],
          streamingMessage: state?.streamingMessage, pendingToolCalls: state?.pendingToolCalls ?? new Set(), compacting: session.inner.isCompacting,
          startedAt: getActivePromptRunStartedAt(id) });
        const prior = entries.get(id);
        if (prior?.runId === next.runId) next.browser ||= prior.browser;
        entries.set(id, next);
      } else {
        const prior = entries.get(id);
        if (prior?.status === "working") {
          const error = !prompt ? session?.inner.agent.state?.errorMessage : undefined;
          entries.set(id, { ...prior, status: error ? "error" : "ended", phase: error ? `执行失败：${error}` : "本轮执行已结束" });
        }
      }
    }
    const activities = [...entries.values()];
    const signature = JSON.stringify(activities.map(({ updatedAt, ...activity }) => { void updatedAt; return activity; }));
    if (signature !== previous) { previous = signature; send(activities); }
  };
  const tick = () => { try { refresh(); } catch { cleanup(); } };
  const timer = setInterval(tick, 750);
  const cleanup = () => {
    closed = true;
    clearInterval(timer);
    if (scheduled) clearTimeout(scheduled);
    for (const item of subscriptions.values()) item.off();
    subscriptions.clear();
  };
  tick();
  return cleanup;
}
