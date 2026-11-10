"use client";

import { useEffect, useRef, useState } from "react";
import { isPendingRoomRequest, roomRequestKey, type RoomUiRequest } from "@/lib/room-ui";
import type { ExtensionUiResponse } from "@/lib/types";
import { ExtensionCustomPanel, ExtensionDialog } from "./ExtensionUi";
import { UserInputCard } from "./UserInputCard";
import { useI18n } from "@/hooks/useI18n";

export function RoomRequests({ requests }: { requests: RoomUiRequest[] }) {
  const { locale } = useI18n();
  const [now, setNow] = useState(Date.now);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const inputQueue = useRef(Promise.resolve());
  const live = useRef(requests);
  live.current = requests;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const items = requests.filter(item => isPendingRoomRequest(item, now) && !answered.has(roomRequestKey(item)));
  const item = items[0];
  if (!item) return null;
  const request = item.request;
  const key = roomRequestKey(item);
  const send = async (body: Record<string, unknown>, settle: boolean) => {
    if (pending.current.has(key) || !live.current.some(candidate => roomRequestKey(candidate) === key && isPendingRoomRequest(candidate, Date.now()))) return;
    pending.current.add(key); setError(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(item.sessionId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, id: request.id }),
      });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
      if (settle) setAnswered(previous => new Set([...previous, key]));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current.delete(key); }
  };
  const respond = (_: unknown, response: Omit<ExtensionUiResponse, "type" | "id">) => { void send({ ...response, type: "extension_ui_response" }, true); };
  const titled = "title" in request ? { ...request, title: `${item.memberName} · ${request.title}` } : request;
  return <>
    <div role="status" style={{ position: "absolute", top: 8, left: 16, zIndex: 100, background: "var(--bg-panel)", padding: 8, fontSize: "var(--text-sm)" }}>
      {locale === "zh-CN" ? `${item.memberName} 等待输入 · ${items.length} 项待处理` : `${item.memberName} awaiting input · ${items.length} pending`}
      {error && <div role="alert">{error}</div>}
    </div>
    {titled.method === "request_user_input" ? <UserInputCard key={key} request={titled} onRespond={respond} />
      : titled.method === "custom" ? <ExtensionCustomPanel key={key} request={titled} onInput={(_, data) => { inputQueue.current = inputQueue.current.then(() => send({ type: "extension_ui_input", data }, false)); }} />
      : titled.method === "confirm" || titled.method === "select" || titled.method === "input" || titled.method === "editor"
        ? <ExtensionDialog key={key} request={titled} onRespond={respond} /> : null}
  </>;
}
