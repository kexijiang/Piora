import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionLike } from "./pi-types";

/** Snapshot both SDK queues using public APIs, without yielding to the agent loop. */
export function snapshotQueuedInputs(inner: AgentSessionLike): AgentMessage[] {
  const agent = inner.agent;
  if (!agent.peekQueuedMessages || !agent.clearSteeringQueue || !agent.steer) throw new Error("Queue recovery is unavailable for this runtime.");
  const steeringMode = agent.steeringMode;
  const followUpMode = agent.followUpMode;
  const steeringCount = inner.getSteeringMessages().length;
  const followUpCount = inner.getFollowUpMessages().length;
  let steering: AgentMessage[] = [];
  let removed = false;
  try {
    agent.steeringMode = "all";
    agent.followUpMode = "all";
    if (steeringCount) {
      steering = agent.peekQueuedMessages();
      if (steering.length !== steeringCount || steering.some(message => message.role !== "user")) throw new Error("The pending queue contains unsupported messages; nothing was removed.");
      agent.clearSteeringQueue();
      removed = true;
    }
    const followUp = agent.peekQueuedMessages();
    if (followUp.length !== followUpCount || followUp.some(message => message.role !== "user")) throw new Error("The pending queue changed; nothing was removed.");
    return [...steering, ...followUp];
  } finally {
    // Synchronous restoration cannot race with an SDK queue drain.
    if (removed) for (const message of steering) agent.steer(message);
    agent.steeringMode = steeringMode;
    agent.followUpMode = followUpMode;
  }
}

export function sameQueuedInputs(left: AgentMessage[], right: AgentMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}
