"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaborationRoom, RoomArtifact, RoomMessage, RoomPresence, RoomSubmission, RoomTask } from "@/lib/room-types";
import type { RoomUiRequest } from "@/lib/room-ui";
import type { RoomActivity } from "@/lib/room-activity";
import type { TeamRunState } from "@/lib/team-types";
import { mergeRoomActivities } from "@/lib/room-conversation";

export const roomActor = (room: CollaborationRoom) => room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId)?.binding.sessionId ?? room.members[0]?.binding.sessionId ?? "";
export const mergeRoomMessages = (current: RoomMessage[], incoming: RoomMessage[]) => [...new Map([...current, ...incoming].map((message) => [message.id, message])).values()].sort((a, b) => a.seq - b.seq);

export function useRoomData(initialRoom: CollaborationRoom, onRoomChange?: (room: CollaborationRoom) => void) {
  const [uiRequests, setUiRequests] = useState<RoomUiRequest[]>([]);
  const [room, setRoom] = useState(initialRoom);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [runs, setRuns] = useState<TeamRunState[]>([]);
  const [artifacts, setArtifacts] = useState<RoomArtifact[]>([]);
  const [activities, setActivities] = useState<RoomActivity[]>([]);
  const [submissions, setSubmissions] = useState<RoomSubmission[]>([]);
  const [presence, setPresence] = useState<Map<string, RoomPresence>>(new Map());
  const [connection, setConnection] = useState("connecting");
  const callbackRef = useRef(onRoomChange);
  callbackRef.current = onRoomChange;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const epochRef = useRef(0);
  const acceptRoom = useCallback((next: CollaborationRoom) => { setRoom(next); callbackRef.current?.(next); }, []);
  const acceptRun = useCallback((next: TeamRunState) => setRuns((current) => {
    if (current.some((run) => run.id === next.id && run.revision > next.revision)) return current;
    return [next, ...current.filter((run) => run.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt);
  }), []);
  const id = initialRoom.id;
  const actor = roomActor(initialRoom);

  useEffect(() => {
    const epoch = ++epochRef.current;
    let disposed = false;
    const current = () => !disposed && epochRef.current === epoch;
    setUiRequests([]); setRoom(initialRoom); setMessages([]); setTasks([]); setRuns([]); setArtifacts([]); setActivities([]); setSubmissions([]); setPresence(new Map()); setConnection("connecting");
    const base = `/api/rooms/${encodeURIComponent(id)}`;
    const query = `sessionId=${encodeURIComponent(actor)}`;
    const refresh = async () => {
      const results = await Promise.allSettled([
        fetch(`${base}?${query}`, { cache: "no-store" }).then(async (response) => response.ok ? response.json() : undefined),
        fetch(`${base}/runs?${query}`, { cache: "no-store" }).then(async (response) => response.ok ? response.json() : undefined),
        fetch(`${base}/messages?${query}`, { cache: "no-store" }).then(async (response) => response.ok ? response.json() : undefined),
      ]);
      if (!current()) return;
      const snapshot = results[0].status === "fulfilled" ? results[0].value : undefined;
      const team = results[1].status === "fulfilled" ? results[1].value : undefined;
      const deliveries = results[2].status === "fulfilled" ? results[2].value : undefined;
      if (snapshot?.uiRequests) setUiRequests(snapshot.uiRequests);
      if (snapshot?.room) acceptRoom(snapshot.room);
      if (snapshot?.messages) setMessages((previous) => mergeRoomMessages(previous, snapshot.messages));
      if (snapshot?.tasks) setTasks(snapshot.tasks);
      if (snapshot?.artifacts) setArtifacts(snapshot.artifacts);
      if (team?.runs) setRuns((previous) => {
        const byId = new Map(previous.map((run) => [run.id, run]));
        for (const run of team.runs as TeamRunState[]) if ((byId.get(run.id)?.revision ?? -1) <= run.revision) byId.set(run.id, run);
        return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      if (deliveries?.messages) setMessages((previous) => mergeRoomMessages(previous, deliveries.messages));
      if (deliveries?.submissions) setSubmissions(deliveries.submissions);
    };
    refreshRef.current = refresh;
    const source = new EventSource(`${base}/events?${query}`);
    source.onopen = () => { if (current()) { setConnection("connected"); void refresh(); } };
    source.onerror = () => { if (current()) { setConnection("reconnecting"); void refresh(); } };
    source.onmessage = (event) => {
      if (!current()) return;
      try {
        const data = JSON.parse(event.data);
        if (data.room) acceptRoom(data.room);
        if (data.type === "snapshot") {
          if (data.messages) setMessages((previous) => mergeRoomMessages(previous, data.messages));
          setTasks(data.tasks ?? []); setArtifacts(data.artifacts ?? []);
        } else if (data.type === "message" && data.message) setMessages((previous) => mergeRoomMessages(previous, [data.message]));
        else if (data.type === "ui_requests") setUiRequests(data.requests ?? []);
        else if (data.type === "activity") setActivities((previous) => mergeRoomActivities(previous, data.activities ?? []));
        else if (data.type === "presence" && data.presence) setPresence((previous) => {
          const next = new Map(previous);
          if (data.presence.status === "processing") next.set(data.presence.sessionId, data.presence); else next.delete(data.presence.sessionId);
          return next;
        });
        else if (data.type === "task" && data.task) setTasks((previous) => [...previous.filter((task) => task.id !== data.task.id), data.task]);
        else if (data.type === "artifact" && data.artifact) setArtifacts((previous) => [...previous.filter((artifact) => artifact.id !== data.artifact.id), data.artifact]);
      } catch { /* Reconciliation restores malformed or missed frames. */ }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible);
    return () => { disposed = true; source.close(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); };
    // Room identity owns this connection; newer room snapshots are accepted separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, actor, acceptRoom]);

  const activeRunId = runs.find((run) => !["completed", "failed", "cancelled"].includes(run.phase))?.id;
  useEffect(() => {
    if (!activeRunId) return;
    let disposed = false;
    const epoch = epochRef.current;
    const base = `/api/rooms/${encodeURIComponent(id)}/runs/${encodeURIComponent(activeRunId)}`;
    const query = `sessionId=${encodeURIComponent(actor)}`;
    const source = new EventSource(`${base}/events?${query}`);
    const refreshRun = () => void fetch(`${base}?${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).then((data) => {
      if (!disposed && epochRef.current === epoch && data?.run) acceptRun(data.run);
    }).catch(() => {});
    source.addEventListener("snapshot", (event) => {
      if (disposed || epochRef.current !== epoch) return;
      try { const data = JSON.parse((event as MessageEvent).data); if (data.run) acceptRun(data.run); } catch { /* Reconnect uses a fresh snapshot. */ }
    });
    source.addEventListener("team.event", refreshRun); source.onerror = refreshRun;
    return () => { disposed = true; source.close(); };
  }, [id, actor, activeRunId, acceptRun]);

  return { uiRequests, room, messages, setMessages, tasks, runs, artifacts, activities, submissions, setSubmissions, presence, connection, acceptRoom, acceptRun,
    refresh: useCallback(() => refreshRef.current(), []) };
}
