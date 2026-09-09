"use client";

import { useMemo, useState } from "react";
import type { RoomMessage } from "@/lib/room-types";
import { previewUserContent, shouldCollapseUserContent } from "@/lib/collapsible-content";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import styles from "./RoomWorkspace.module.css";

export function CollapsibleUserContent({ message, cwd, sessionId, onRetry, retryDisabled }: { message: RoomMessage; cwd?: string; sessionId: string; onRetry?: (content: string) => Promise<void>; retryDisabled?: boolean }) {
  const initiallyCollapsed = shouldCollapseUserContent(message.payload);
  const [expanded, setExpanded] = useState(!initiallyCollapsed);
  const [fullContent, setFullContent] = useState(message.payload.truncated ? null : message.content);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const visibleContent = useMemo(
    () => expanded ? (fullContent ?? message.content) : previewUserContent(message.content),
    [expanded, fullContent, message.content],
  );

  const loadFullContent = async (): Promise<string> => {
    if (fullContent !== null) return fullContent;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/content?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { content?: string; error?: string };
      if (!response.ok || typeof data.content !== "string") throw new Error(data.error ?? `HTTP ${response.status}`);
      setFullContent(data.content);
      return data.content;
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
      throw reason;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (message.payload.truncated) {
      try { await loadFullContent(); } catch { return; }
    }
    setExpanded(true);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(await loadFullContent()); } catch { /* Error is rendered inline. */ }
  };

  return (
    <div className={styles.collapsibleContent}>
      <MarkdownBody cwd={cwd}>{visibleContent}</MarkdownBody>
      {initiallyCollapsed ? (
        <div className={styles.contentActions}>
          <button type="button" aria-expanded={expanded} disabled={loading} onClick={() => { void toggle(); }}>{loading ? "加载中…" : expanded ? "收起" : "展开全文"}</button>
          <button type="button" disabled={loading} onClick={() => { void copy(); }}>复制全文</button>
          <span>{message.payload.lineCount} 行 · {message.payload.byteLength.toLocaleString()} 字节</span>
        </div>
      ) : null}
      {onRetry ? <div className={styles.contentActions}><button type="button" disabled={loading || retrying || retryDisabled} title="重新发送这条群聊消息" onClick={() => {
        if (loading || retrying || retryDisabled) return;
        setRetrying(true); setError(null);
        void loadFullContent().then(onRetry).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setRetrying(false));
      }}>{retrying ? "正在重试…" : "重试"}</button></div> : null}
      {error ? <small className={styles.contentError} role="alert">{error}</small> : null}
    </div>
  );
}
