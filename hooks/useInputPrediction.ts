"use client";
import { useEffect, useState } from "react";
import type { ReplySource } from "@/lib/reply-suggestions";
import { defaultPredictionSettings, readPredictionSettings } from "@/lib/input-prediction";
import { readComposerRecord, writeComposerRecord, replyCacheKey } from "@/lib/reply-storage";
const attempted = new Set<string>();
export function useInputPrediction(source: ReplySource | null, cwd: string | null | undefined, locale: string, hasInput: boolean) {
  const [settings, setSettings] = useState(defaultPredictionSettings);
  const [result, setResult] = useState({ key: "", text: "" });
  useEffect(() => { const refresh = () => setSettings(readPredictionSettings(cwd)); refresh(); window.addEventListener("piora:input-prediction", refresh); window.addEventListener("storage", refresh); return () => { window.removeEventListener("piora:input-prediction", refresh); window.removeEventListener("storage", refresh); }; }, [cwd]);
  const key = source && settings.enabled && settings.model ? JSON.stringify([source.sessionId, source.sourceEntryId, null, settings, locale]) : "";
  useEffect(() => {
    if (!key || hasInput) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void (async () => {
      try {
        const cacheKey = `prediction:${await replyCacheKey(key)}`;
        const saved = await readComposerRecord<{ text: string }>("replies", cacheKey).catch(() => undefined);
        if (controller.signal.aborted) return;
        if (saved) { setResult({ key, text: saved.text }); return; }
        if (attempted.has(key)) return;
        attempted.add(key);
        while (attempted.size > 1000) attempted.delete(attempted.values().next().value!);
        const [sessionId, sourceEntryId, leafId, config, language] = JSON.parse(key);
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input-prediction`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs + 2000)]), body: JSON.stringify({ sourceEntryId, leafId, ...config, locale: language }) });
        const data = await response.json();
        if (controller.signal.aborted || !response.ok || typeof data.text !== "string") return;
        await writeComposerRecord("replies", cacheKey, { key: cacheKey, text: data.text, used: Date.now() }).catch(() => {});
        if (!controller.signal.aborted) setResult({ key, text: data.text });
      } catch { /* Optional prediction never blocks composing. */ }
    })(); }, 700);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, hasInput]);
  return !hasInput && result.key === key ? result.text : "";
}
