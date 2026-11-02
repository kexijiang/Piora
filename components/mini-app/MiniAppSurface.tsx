"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../hooks/useI18n";
import { acquireMiniAppClient } from "../../lib/mini-app/client-cache";
import { MiniAppController } from "../../lib/mini-app/controller";
import { isMiniAppError } from "../../lib/mini-app/limits";
import { miniAppEnvelopeIdentity } from "../../lib/mini-app/client-protocol";
import { miniAppPlaybackMode } from "../../lib/mini-app/playback";
import type { MiniAppStateClient, MiniAppClientView } from "../../lib/mini-app/client-state";
import styles from "./MiniAppSurface.module.css";
import MiniAppMigration from "./MiniAppMigration";
import AnswerConversion from "../AnswerConversion";
import MiniAppActions from "./MiniAppActions";

interface Props {
  payload: unknown; snapshot: string; sessionId?: string; toolCallId: string;
  entryId?: string; branchKey?: string; envelopeVersion?: number; readOnly?: boolean;
  interactionPaused?: boolean;
}
const empty: MiniAppClientView = { status: "loading", drafts: [], needsRecovery: false };
const noSubscribe = () => () => {};
const emptySnapshot = () => empty;
const copy = {
  en: { title: "Interactive answer", loading: "Loading saved state…", saved: "Saved · ready for your next message", saving: "Saving…", error: "Saving or loading did not finish. Check the retained checkpoints before continuing.", conflict: "Saved state changed in another view. Your local checkpoint is retained.",
    moreDrafts: "Load more checkpoints", reloadDrafts: "Refresh checkpoints", loadingDrafts: "Loading checkpoints…", draftsError: "Checkpoints could not be read. Your local copies are retained; try again.", contextLost: "The 3D view stopped because its graphics context was lost. Your checkpoint is retained. Use Resume from checkpoint to try again.",
    play: "Play", pause: "Pause and save", step: "Step", reset: "Reset", stop: "Stop", resume: "Resume from checkpoint", save: "Save", retry: "Retry", useSaved: "Keep local drafts and use saved state", refresh: "Refresh publication", export: "Export checkpoint", recover: "Recover this checkpoint", recovery: "Local checkpoints need review", recoveryHint: "Recover a checkpoint, or keep it here and continue with the saved state.", retained: "Retained local checkpoints", paused: "Paused", ready: "Ready", finished: "Finished", playing: "Playing", stopped: "Stopped", pending: "Waiting for publication", aborted: "This version was not published", superseded: "A newer version is available; this version is read-only", review: "This revision needs confirmation", unavailable: "Interactive view unavailable", failure: "The action did not finish. Your checkpoints are retained.", summary: "Current result" },
  "zh-CN": { title: "交互回答", loading: "正在加载已保存状态…", saved: "已保存 · 后续追问可读取当前状态", saving: "正在保存…", error: "加载或保存未完成，请核对保留的检查点后继续。", conflict: "其他窗口或分支的状态已变化，本机检查点仍已保留。",
    moreDrafts: "加载更多检查点", reloadDrafts: "刷新检查点列表", loadingDrafts: "正在读取检查点…", draftsError: "检查点读取失败，本机副本仍已保留，请重试。", contextLost: "三维画面的图形上下文已丢失，运行已停止，检查点仍已保留。可点击“从检查点恢复”重试。",
    play: "播放", pause: "暂停并保存", step: "单步", reset: "复位", stop: "停止", resume: "从检查点恢复", save: "保存", retry: "重试", useSaved: "保留本机草稿并使用已保存状态", refresh: "刷新发布状态", export: "另存检查点", recover: "恢复这份检查点", recovery: "有本机检查点需要核对", recoveryHint: "可以恢复检查点，也可以先保留它并继续使用已保存状态。", retained: "保留的本机检查点", paused: "已暂停", ready: "已就绪", finished: "已完成", playing: "正在播放", stopped: "已停止", pending: "正在等待发布确认", aborted: "此版本未发布", superseded: "已有新版本，此版本仅供查看", review: "此变更需要确认", unavailable: "交互界面暂不可用", failure: "操作未完成，检查点仍已保留。", summary: "当前结果" },
};

function ConnectedSurface({ sessionId, toolCallId, payload, branchKey, snapshot, interactionPaused }: Props & { sessionId: string }) {
  const { locale } = useI18n(), text = copy[locale === "en" ? "en" : "zh-CN"];
  const { operationId, planDigest, revision, runtimeVersion } = miniAppEnvelopeIdentity(payload);
  const container = useRef<HTMLDivElement>(null), controller = useRef<MiniAppController | undefined>(undefined), execution = useRef<AbortController | undefined>(undefined);
  const [client, setClient] = useState<MiniAppStateClient>();
  const [run, setRun] = useState<"paused" | "playing" | "stopped">("stopped");
  const [restart, setRestart] = useState(0), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const view = useSyncExternalStore(client?.subscribe ?? noSubscribe, client?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const publication = view.output?.publication.status;
  const playable = !!view.output && miniAppPlaybackMode(view.output.plan) !== "none";
  const finished = view.current?.frame.playback?.finished === true;
  const usable = !!view.output?.writable && publication === "committed" && !view.needsRecovery && view.status !== "error" && view.status !== "conflict";

  // The generic host keeps controls inert until history and state settle.
  // Stop autonomous advancement too; retaining the runtime preserves its draft.
  useEffect(() => { if (interactionPaused) controller.current?.pause(); }, [interactionPaused]);

  useEffect(() => {
    const lease = acquireMiniAppClient(sessionId, toolCallId, { operationId, planDigest, revision, runtimeVersion }, branchKey ?? "", () => { execution.current?.abort(); controller.current?.stop(); });
    // Establish the external store after the view owns its subscription lease.
    setClient(lease.client);
    void lease.client.load().catch(() => {});
    return () => { execution.current?.abort(); controller.current?.stop(); lease.release(); };
  }, [sessionId, toolCallId, operationId, planDigest, revision, runtimeVersion, branchKey]);

  useEffect(() => {
    if (!client || !container.current || !usable) return;
    const current = client.getSnapshot();
    if (!current.output || !current.current) return;
    const abort = new AbortController(); execution.current = abort;
    void MiniAppController.create(container.current, current.output.plan, { snapshot: current.current.snapshot, signal: abort.signal, playGroup: sessionId,
      onChange: (result, changed) => { if (changed) client.update(result); },
      onStatus: status => { if (!abort.signal.aborted) setRun(status); },
      onError: error => { if (!abort.signal.aborted) { setRuntimeError(error.code); setFailed(true); setRun("stopped"); } },
    }).then(host => {
      if (abort.signal.aborted) { host.stop(); return; }
      controller.current = host;
      setRuntimeError(undefined);
      client.setCheckpointGate(work => host.withCheckpoint(work));
    }).catch(error => { if (!abort.signal.aborted) { setRuntimeError(isMiniAppError(error) ? error.code : "EXECUTION"); setFailed(true); setRun("stopped"); } });
    return () => { abort.abort(); controller.current?.stop(); controller.current = undefined; client.setCheckpointGate(undefined); };
  }, [client, usable, restart, sessionId, view.restoreRevision]);

  useEffect(() => {
    if (!client || publication !== "candidate") return;
    let cancelled = false, attempt = 0, timer: ReturnType<typeof setTimeout>;
    const delays = [500, 1000, 2000, 4000, 8000, 8000];
    const poll = () => {
      if (cancelled || attempt >= delays.length || client.getSnapshot().output?.publication.status !== "candidate") return;
      timer = setTimeout(() => { if (document.hidden) { poll(); return; } void client.load().catch(() => {}).finally(poll); }, delays[attempt++]);
    };
    poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [client, publication]);

  const act = (work: () => Promise<void>) => {
    if (busy) return; setBusy(true); setFailed(false); setActionError(undefined);
    void work().catch(error => { setActionError(isMiniAppError(error) ? error.code : "UNAVAILABLE"); setFailed(true); }).finally(() => setBusy(false));
  };
  const exportDraft = async (id?: string) => {
    if (!client) return;
    const body = id ? await client.exportDraft(id) : client.exportCurrent(), url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "piora-checkpoint.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const status = view.error?.code === "STORAGE" ? (locale === "en" ? "Local recovery storage is unavailable. Keep this page open, retry or export the current checkpoint." : "本机恢复存储不可用。请保持页面开启，重试或先另存当前检查点。")
    : publication === "candidate" ? text.pending : publication === "awaiting_confirmation" ? text.review
    : publication === "aborted" ? text.aborted : publication === "superseded" ? text.superseded : text[view.status];
  return <section className={styles.surface} data-mini-app-surface data-mini-app-runtime-error={runtimeError} data-mini-app-action-error={actionError} data-mini-app-state-error={view.error?.code} aria-label={view.output?.plan.title ?? text.title}>
    <header className={styles.header}><h3>{view.output?.plan.title ?? text.title}</h3><span className={styles.badge}>Intelligent UI</span></header>
    <div ref={container} className={styles.document} />
    {(!usable || run === "stopped") && <p className={styles.snapshot}>{view.current?.frame.summary ?? snapshot}</p>}
    {usable && <div className={styles.controls}>
      {run === "stopped" ? <button type="button" disabled={busy} onClick={() => act(async () => { await client!.flush(); setRestart(value => value + 1); })}>{text.resume}</button>
        : <>{playable && <><button type="button" disabled={busy || finished} onClick={() => run === "playing" ? act(() => client!.flush()) : controller.current?.play()}>{run === "playing" ? text.pause : text.play}</button>
          <button type="button" disabled={busy || finished} onClick={() => controller.current?.step()}>{text.step}</button></>}
          <button type="button" disabled={busy} onClick={() => controller.current?.reset()}>{text.reset}</button>
          <button type="button" disabled={busy} onClick={() => act(async () => {
            const host = controller.current;
            if (host) await host.withCheckpoint(async () => { host.stop(); });
            await client!.flush();
          })}>{text.stop}</button></>}
      <button type="button" disabled={busy} onClick={() => act(() => client!.flush())}>{text.save}</button>
      <span className={styles.status} role="status">{run === "paused" ? finished ? text.finished : !playable ? text.ready : text.paused : text[run]}</span>
    </div>}
    <footer className={styles.footer}>
      <p role={view.status === "error" || view.status === "conflict" ? "alert" : "status"}>{status}</p>
      {publication === "awaiting_confirmation" && (view.output!.plan.conversion
        ? <AnswerConversion kind="mini-app" sessionId={sessionId} toolCallId={toolCallId} english={locale === "en"} />
        : <MiniAppMigration sessionId={sessionId} toolCallId={toolCallId} english={locale === "en"} />)}
      {client && !!view.output?.plan.actions?.actions.length && <MiniAppActions client={client} english={locale === "en"} />}
      {failed && <p role="alert">{runtimeError === "CONTEXT_LOST" ? text.contextLost : runtimeError === "GRAPHICS_UNAVAILABLE" ? locale === "en" ? "This window cannot display the 3D scene. Your checkpoint is retained; resume to retry." : "当前窗口无法显示三维画面，检查点仍已保留，可从检查点恢复后重试。" : text.failure}</p>}
      {client && (view.status === "error" || view.status === "conflict") && <div className={styles.controls}>
        <button type="button" disabled={busy} onClick={() => act(() => view.output ? client.flush() : client.load())}>{text.retry}</button>
        <button type="button" disabled={busy} onClick={() => act(() => client.useSavedState())}>{text.useSaved}</button>
        {view.current && <button type="button" disabled={busy} onClick={() => act(() => exportDraft())}>{locale === "en" ? "Export current checkpoint" : "另存当前检查点"}</button>}
      </div>}
      {client && publication === "candidate" && <div className={styles.controls}><button type="button" disabled={busy} onClick={() => act(() => client.load())}>{text.refresh}</button></div>}
      {client && (view.drafts.length > 0 || view.hasMoreDrafts) && <details open={view.needsRecovery} className={styles.recovery} aria-busy={view.draftsLoading}>
        <summary>{view.needsRecovery ? text.recovery : text.retained}</summary><p>{text.recoveryHint}</p>
        {view.drafts.map(draft => <div key={draft.id} className={styles.draft}><p>{draft.summary}</p><div className={styles.controls}>
          <button type="button" disabled={busy} onClick={() => act(() => client.recover(draft.id))}>{text.recover}</button>
          <button type="button" disabled={busy} onClick={() => act(() => exportDraft(draft.id))}>{text.export}</button>
        </div></div>)}
        {view.draftsError && <p role="alert">{text.draftsError}</p>}
        {view.draftsLoading && <p role="status">{text.loadingDrafts}</p>}
        <div className={styles.controls}>
          {view.hasMoreDrafts && <button type="button" disabled={busy || view.draftsLoading} onClick={() => act(() => client.loadMoreDrafts())}>{text.moreDrafts}</button>}
          <button type="button" disabled={busy || view.draftsLoading} onClick={() => act(() => client.reloadDrafts())}>{text.reloadDrafts}</button>
          <button type="button" disabled={busy} onClick={() => act(() => client.useSavedState())}>{text.useSaved}</button>
        </div>
      </details>}
      {usable && run !== "stopped" && <details><summary>{text.summary}</summary><p className={styles.currentSummary}>{view.current?.frame.summary}</p></details>}
    </footer>
  </section>;
}

export default function MiniAppSurface(props: Props) {
  let identity;
  try { identity = miniAppEnvelopeIdentity(props.payload); } catch { /* Keep the durable text readable. */ }
  if (!identity || props.readOnly || !props.sessionId || props.envelopeVersion !== 1) return <div className={styles.snapshot}>{props.snapshot}</div>;
  return <ConnectedSurface key={`${props.sessionId}:${props.toolCallId}:${identity.operationId}:${props.branchKey ?? ""}`} {...props} sessionId={props.sessionId} />;
}
