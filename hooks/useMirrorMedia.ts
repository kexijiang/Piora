"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { harmonyJson } from "@/lib/harmony/client";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { showPioraMessage } from "@/components/PioraMessage";
import type { HarmonyMediaArtifact, HarmonyRecordingState } from "@/lib/harmony/types";

type MediaAction = "capture_screenshot" | "start_recording" | "stop_recording" | "retrieve_recording" | "abandon_recording" | "retry_recording_save" | "discard_recording_draft";
type MediaSnapshot = { recording: HarmonyRecordingState | null; recoveries?: HarmonyRecordingState[]; completion?: { artifact: HarmonyMediaArtifact; stopReason?: string } };
type Scope = { serial: string; ownerId: string; abort: AbortController; revision: number; busy: boolean; observed: HarmonyRecordingState | null };

/** Media has its own lifetime: closing/pausing a video worker never stops an MP4 writer. */
export function useMirrorMedia(serial: string, ownerId: string, active: boolean, chinese: boolean) {
  const [recording, setRecording] = useState<HarmonyRecordingState | null>(null);
  const [recoveries, setRecoveries] = useState<HarmonyRecordingState[]>([]);
  const [busy, setBusy] = useState<MediaAction | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [artifact, setArtifact] = useState<HarmonyMediaArtifact | null>(null);
  const scope = useRef<Scope | null>(null);
  const notice = useRef<(file: HarmonyMediaArtifact, id?: string, reason?: string) => Promise<void>>(async () => {});
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);

  const showArtifact = useCallback(async (file: HarmonyMediaArtifact, id?: string, reason?: string) => {
    const expected = scope.current;
    let copied = false;
    try { if (window.piDesktop?.clipboard?.copyHarmonyMedia) { await window.piDesktop.clipboard.copyHarmonyMedia({ kind: file.kind, path: file.path }); copied = true; } } catch { /* Saving remains successful independently of clipboard access. */ }
    if (scope.current !== expected || expected?.abort.signal.aborted) return;
    const reasons: Record<string, string> = {
      "duration-limit": copy("已达到30分钟上限。", "30 minute limit reached."), "size-limit": copy("已达到文件大小上限。", "File size limit reached."),
      "disk-space": copy("磁盘空间不足，已保存已有内容。", "Low disk space; captured footage saved."),
      "format-changed": copy("画面规格变化，已保存本段。", "Video format changed; segment saved."),
      "interrupted": copy("连接中断，已保存可播放部分。", "Connection interrupted; playable footage saved."),
    };
    const action = await showPioraMessage({ title: copy(file.kind === "screenshot" ? "截图已保存" : "录屏已保存", "Media saved"), tone: "success", presentation: "notice", durationMs: 3000,
      ...(id ? { notificationKey: `recording-${id}` } : {}),
      message: reason ? reasons[reason] ?? reason : copied ? copy("已复制到剪贴板", "Copied to clipboard") : copy("保存成功，剪贴板复制未完成", "Saved; clipboard copy did not complete"),
      actions: [{ id: "folder", label: copy("打开文件夹", "Show folder") }, { id: "done", label: copy("关闭", "Close") }],
    });
    if (action === "folder") await window.piDesktop?.revealPath?.(file.path);
  }, [copy]);
  useEffect(() => { notice.current = showArtifact; }, [showArtifact]);

  const refresh = useCallback(async (expected: Scope) => {
    if (scope.current !== expected || expected.abort.signal.aborted) return;
    const revision = ++expected.revision, previous = expected.observed;
    const query = new URLSearchParams({ serial: expected.serial, ownerId: expected.ownerId, recordingId: previous?.recordingId ?? "" });
    const snapshot = await harmonyJson<MediaSnapshot>(`/api/harmony/media?${query}`, undefined, AbortSignal.any([expected.abort.signal, AbortSignal.timeout(8000)]));
    if (scope.current !== expected || expected.abort.signal.aborted || revision !== expected.revision) return;
    expected.observed = snapshot.recording; setRecording(snapshot.recording); setRecoveries(snapshot.recoveries ?? []);
    if (previous?.ownerId === expected.ownerId && snapshot.completion && previous.recordingId !== snapshot.recording?.recordingId && !expected.busy) {
      setArtifact(snapshot.completion.artifact);
      void notice.current(snapshot.completion.artifact, previous.recordingId, snapshot.completion.stopReason).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    setRecording(null); setRecoveries([]); setBusy(null); setElapsed(0); setArtifact(null);
    if (!active || !serial || !ownerId) return;
    const expected: Scope = { serial, ownerId, abort: new AbortController(), revision: 0, busy: false, observed: null };
    scope.current = expected;
    let pending = false;
    const poll = () => {
      if (pending || expected.busy) return;
      pending = true; void refresh(expected).catch(() => undefined).finally(() => { pending = false; });
    };
    poll(); const timer = setInterval(poll, 2000);
    const events = new EventSource("/api/harmony/events"); events.onmessage = poll;
    return () => { expected.abort.abort(); clearInterval(timer); events.close(); if (scope.current === expected) scope.current = null; };
  }, [serial, ownerId, active, refresh]);

  useEffect(() => {
    const tick = () => setElapsed(recording ? Math.max(0, Math.floor((Date.now() - Date.parse(recording.startedAt)) / 1000)) : 0);
    tick(); if (!recording) return;
    const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [recording]);

  const action = useCallback(async (action: MediaAction, recoveryId?: string): Promise<boolean> => {
    const expected = scope.current;
    if (!expected || expected.busy || expected.abort.signal.aborted) return false;
    if (action === "start_recording" && expected.observed) return false;
    if (["stop_recording", "retrieve_recording", "abandon_recording"].includes(action) && (!expected.observed || expected.observed.ownerId !== ownerId)) return false;
    expected.busy = true; expected.revision++; setBusy(action);
    const id = recoveryId ?? expected.observed?.recordingId;
    const budget = ["stop_recording", "retrieve_recording", "retry_recording_save"].includes(action) ? 180000 : 30000;
    try {
      const result = await harmonyJson<{ recording?: HarmonyRecordingState; artifact?: HarmonyMediaArtifact }>("/api/harmony/media", {
        action, serial, ownerId, ...(id ? { recordingId: id } : {}),
      }, AbortSignal.any([expected.abort.signal, AbortSignal.timeout(budget)]));
      if (scope.current !== expected || expected.abort.signal.aborted) return false;
      if (result.recording) {
        expected.observed = result.recording; setRecording(result.recording);
        if (result.recording.systemRecorderStateUnknown) void showPioraMessage({ title: copy("请确认手机录屏状态", "Check recording on the phone"), tone: "info",
          message: copy("无法确认系统录屏状态。请先在手机上停止录屏，再点击“我已停止，取回录屏”。不要重复开始录屏。", "Recording status is unknown. Stop recording on the phone before retrieving it. Do not start it again."),
          actions: [{ id: "done", label: copy("知道了", "OK"), primary: true }] });
      }
      if (result.artifact) {
        setArtifact(result.artifact);
        if (result.artifact.kind === "recording") { expected.observed = null; setRecording(null); }
        void notice.current(result.artifact, result.artifact.kind === "recording" ? id : undefined).catch(() => undefined);
      }
      // The mutation already succeeded. A failed status read must not turn a
      // saved file into an error or invite the user to replay the operation.
      await refresh(expected).catch(() => undefined); return true;
    } catch (cause) {
      if (scope.current !== expected || expected.abort.signal.aborted) return false;
      // A timeout is ambiguous; reconcile the durable recording ID, never toggle again.
      await refresh(expected).catch(() => undefined);
      if (scope.current === expected) void showPioraMessage({ title: copy("操作未完成", "Action incomplete"), tone: "error",
        message: cause instanceof HarmonyRequestError ? cause.messageFor(chinese) : cause instanceof Error ? cause.message : String(cause), actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] });
      return false;
    } finally { expected.busy = false; if (scope.current === expected) setBusy(null); }
  }, [serial, ownerId, copy, refresh, chinese]);

  const refreshCurrent = useCallback(async () => { if (scope.current) await refresh(scope.current); }, [refresh]);

  return { recording, recoveries, elapsed, busy, artifact, action, refresh: refreshCurrent, ownsRecording: recording?.ownerId === ownerId,
    transitioning: Boolean(busy || recording?.phase && ["preparing", "stopping", "saving"].includes(recording.phase)) };
}
