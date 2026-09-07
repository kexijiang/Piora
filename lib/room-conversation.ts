import type { RoomActivity } from "./room-activity";
import type { RoomMessage } from "./room-types";

const activityKey = (activity: RoomActivity) => `${activity.sessionId}:${activity.runId}`;
export function mergeRoomActivities(current: RoomActivity[], snapshot: RoomActivity[]): RoomActivity[] {
  const incoming = new Map(snapshot.map((item) => [activityKey(item), item]));
  const history = current.map((item) => incoming.has(activityKey(item)) ? item : item.status === "working" ? { ...item, status: "ended" as const, phase: "本轮执行已结束" } : item);
  const result = new Map(history.map((item) => [activityKey(item), item]));
  for (const item of snapshot) {
    const previous = result.get(activityKey(item));
    result.set(activityKey(item), { ...item, startedAt: previous?.startedAt ?? item.startedAt ?? item.updatedAt });
  }
  return [...result.values()].slice(-100);
}

export type RoomConversationEntry = { key: string; timestamp: number } & (
  { kind: "message"; message: RoomMessage } | { kind: "activity"; activity: RoomActivity; hasFinalReply: boolean }
);
export function roomConversationEntries(messages: RoomMessage[], activities: RoomActivity[]): RoomConversationEntry[] {
  const entries: RoomConversationEntry[] = messages.map((message) => ({ key: `message:${message.id}`, timestamp: message.createdAt, kind: "message", message }));
  for (const activity of activities) {
    const timestamp = activity.startedAt ?? activity.updatedAt;
    const hasFinalReply = activity.status !== "working" && Boolean(activity.text.trim()) && messages.some((message) => message.author.id === activity.sessionId && message.createdAt >= timestamp && message.content.trim() === activity.text.trim());
    entries.push({ key: `activity:${activityKey(activity)}`, timestamp, kind: "activity", activity, hasFinalReply });
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp || (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1));
}
