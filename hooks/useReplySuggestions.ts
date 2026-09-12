"use client";
import { useEffect, useState } from "react";
import { defaultReplySettings, REPLY_PROTOCOL_VERSION, type ReplyResult, type ReplySource } from "@/lib/reply-suggestions";
import { readReplySettings, subscribeReplySettings } from "@/lib/reply-suggestions-settings";
import { cacheReply, readComposerRecord, replyCacheKey } from "@/lib/reply-storage";

export function useReplySuggestions(source: ReplySource | null, locale: string) {
  const [settings, setSettings] = useState(defaultReplySettings);
  const [retryState, retry] = useState({ key: "", count: 0 });
  const [state, setState] = useState<{ key: string; result?: ReplyResult; error?: string }>({ key: "" });
  useEffect(() => { const refresh = () => setSettings(readReplySettings()); refresh(); return subscribeReplySettings(refresh); }, []);
  const key = source && settings.enabled && settings.model ? JSON.stringify([source, settings.model, settings.systemPrompt, locale, REPLY_PROTOCOL_VERSION]) : "";
  const attempt = retryState.key === key ? retryState.count : 0;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let alive = true;
    void (async () => {
      setState({ key });
      let cacheKey: string | undefined;
      try {
        cacheKey = await replyCacheKey(JSON.parse(key));
        const cached = await readComposerRecord<{ result: ReplyResult }>("replies", cacheKey);
        if (!alive) return;
        if (cached && attempt === 0) { setState({ key, result: cached.result }); void cacheReply(cacheKey, cached.result).catch(() => {}); return; }
      } catch { /* Cache is optional; extraction and sending remain available. */ }
      if (!alive) return;
      const [snapshot, model, systemPrompt, language] = JSON.parse(key) as [ReplySource, unknown, string, string];
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(snapshot.sessionId)}/reply-suggestions`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ sourceEntryId: snapshot.sourceEntryId, leafId: snapshot.leafId, model, systemPrompt, locale: language }),
        });
        const data = await res.json();
        if (!alive) return;
        if (!res.ok) { if (res.status !== 409) setState({ key, error: data.code ?? "provider_error" }); return; }
        if (!Array.isArray(data.groups)) throw new Error("invalid_output");
        setState({ key, result: data });
        if (cacheKey) void cacheReply(cacheKey, data).catch(() => {});
      } catch { if (alive && !controller.signal.aborted) setState({ key, error: "network_error" }); }
    })();
    return () => { alive = false; controller.abort(); };
  }, [key, attempt]);
  return { sourceKey: key, result: state.key === key ? state.result : undefined, error: state.key === key ? state.error : undefined, retry: () => retry((current) => ({ key, count: current.key === key ? current.count + 1 : 1 })) };
}
