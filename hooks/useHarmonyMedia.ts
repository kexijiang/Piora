"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { showPioraMessage } from "@/components/PioraMessage";
import type { HarmonyMediaArtifact, HarmonyRecordingState } from "@/lib/harmony/types";
import { HarmonyRequestError } from "@/lib/harmony/request-error";

export async function harmonyJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
  return data;
}
export function useHarmonyMedia(serial: string, ownerId: string, active: boolean, chinese: boolean) {
  const [recording, setRecording] = useState<HarmonyRecordingState | null>(null);
  const [recoveries, setRecoveries] = useState<HarmonyRecordingState[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<HarmonyMediaArtifact | null>(null);
  const epoch = useRef(0), busyRef = useRef(false), revision = useRef(0);
  const observed = useRef<HarmonyRecordingState | null>(null);
  const notify = useRef<(file: HarmonyMediaArtifact, key?: string, reason?: string) => Promise<void>>(async () => {});
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = epoch.current;
    const requestRevision = ++revision.current;
    const previous = observed.current;
    const query = new URLSearchParams({ serial, ownerId, recordingId: previous?.recordingId ?? "" });
    const result = await harmonyJson<{ recording: HarmonyRecordingState | null; recoveries?: HarmonyRecordingState[]; completion?: { artifact: HarmonyMediaArtifact; stopReason?: string } }>(`/api/harmony/media?${query}`, undefined, signal);
    if (!signal?.aborted && generation === epoch.current && requestRevision === revision.current) {
      observed.current = result.recording; setRecording(result.recording); setRecoveries(result.recoveries ?? []);
      if (previous?.ownerId === ownerId && result.completion && previous.recordingId !== result.recording?.recordingId && !busyRef.current) {
        setArtifact(result.completion.artifact);
        void notify.current(result.completion.artifact, `recording-${previous.recordingId}`, result.completion.stopReason);
      }
    }
  }, [serial, ownerId]);
  useEffect(() => {
    const generation = ++epoch.current; observed.current = null; setRecording(null); setArtifact(null); setRecoveries([]);
    if (!active || !serial) return;
    const controller = new AbortController();
    let pending = false;
    const update = () => { if (pending || busyRef.current) return; pending = true; void refresh(controller.signal).catch(() => undefined).finally(() => { pending = false; }); };
    update(); const timer = setInterval(update, 2000);
    const events = new EventSource("/api/harmony/events"); events.onmessage = update;
    return () => { epoch.current = generation + 1; controller.abort(); clearInterval(timer); events.close(); };
  }, [serial, active, refresh]);
  useEffect(() => {
    const update = () => setElapsed(recording ? Math.max(0, Math.floor((Date.now() - Date.parse(recording.startedAt)) / 1000)) : 0);
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [recording]);
  const showArtifact = useCallback(async (file: HarmonyMediaArtifact, notificationKey?: string, reason?: string) => {
    const generation = epoch.current;
    let copied = false;
    try { const clipboard = window.piDesktop?.clipboard?.copyHarmonyMedia; if (clipboard) { await clipboard({ kind: file.kind, path: file.path }); copied = true; } } catch { /* File save succeeded independently of clipboard. */ }
    if (generation !== epoch.current) return;
    const reasons: Record<string, string> = { "duration-limit": copy("已达到30分钟上限。", "30 minute limit reached."), "size-limit": copy("已达到文件大小上限。", "File size limit reached."), "disk-space": copy("磁盘空间不足，已停止录屏。", "Recording stopped: low disk space."), "format-changed": copy("画面规格变化，已保存本段。", "Format changed; segment saved."), "interrupted": copy("连接中断，已保留可播放部分。", "Connection interrupted; playable footage saved.") };
    void showPioraMessage({ title: copy(file.kind === "screenshot" ? "截图已保存" : "录屏已保存", "Media saved"), tone: "success", presentation: "notice", durationMs: 3000,
      ...(notificationKey ? { notificationKey } : {}),
      message: reason ? reasons[reason] ?? reason : copied ? copy("已复制到剪贴板", "Copied to clipboard") : copy("保存成功，剪贴板复制未完成", "Saved; clipboard copy did not complete"),
      actions: [{ id: "folder", label: copy("打开文件夹", "Show folder") }, { id: "done", label: copy("关闭", "Close") }],
    }).then(async result => {
      if (result === "folder") await window.piDesktop?.revealPath?.(file.path);
    }).catch(() => undefined);
  }, [copy]);
  useEffect(() => { notify.current = showArtifact; }, [showArtifact]);
  const action = useCallback(async (action: "capture_screenshot" | "start_recording" | "stop_recording" | "retrieve_recording" | "abandon_recording" | "retry_recording_save" | "discard_recording_draft", recoveryId?: string) => {
    if (!serial || !ownerId || busyRef.current) return false;
    busyRef.current = true; ++revision.current; setBusy(action); const generation = epoch.current;
    try {
      const result = await harmonyJson<{ artifact?: HarmonyMediaArtifact; recording?: HarmonyRecordingState }>("/api/harmony/media", {
        action, serial, ownerId, ...(recoveryId || recording ? { recordingId: recoveryId ?? recording!.recordingId } : {}),
      });
      if (generation !== epoch.current) return false;
      if (result.recording) {
        setRecording(result.recording);
        if (result.recording.systemRecorderStateUnknown) await showPioraMessage({ title: copy("请确认手机录屏状态", "Check recording on the phone"), tone: "info", message: copy("无法确认系统录屏是否开始。请先在手机上停止录屏，再到媒体页面点击“我已停止，取回录屏”。不要重复开始录屏。", "Recording status is unknown. Stop it on the phone, then retrieve it from Media."), actions: [{ id: "done", label: copy("知道了", "OK"), primary: true }] });
      }
      if (result.artifact) { setArtifact(result.artifact); if (result.artifact.kind === "recording") setRecording(null); const id = recoveryId ?? recording?.recordingId; await showArtifact(result.artifact, result.artifact.kind === "recording" && id ? `recording-${id}` : undefined); }
      await refresh(); return true;
    } catch (error) {
      if (generation === epoch.current) await refresh().catch(() => undefined);
      if (generation === epoch.current) await showPioraMessage({ title: copy("操作未完成", "Action failed"), message: error instanceof HarmonyRequestError ? error.messageFor(chinese) : error instanceof Error ? error.message : String(error), tone: "error", actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] });
      return false;
    } finally { busyRef.current = false; setBusy(null); }
  }, [serial, ownerId, recording, copy, refresh, showArtifact, chinese]);
  return { recording, recoveries, elapsed, busy, artifact, action, ownsRecording: recording?.ownerId === ownerId, refresh,
    transitioning: Boolean(busy || recording?.phase && ["preparing", "stopping", "saving"].includes(recording.phase)) };
}
