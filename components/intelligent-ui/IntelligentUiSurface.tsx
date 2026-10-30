"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../hooks/useI18n";
import { formatSnapshot, initialState, validateSurface, type UiSurface } from "../../lib/intelligent-ui/surface-document";
import { surfaceState, type SurfaceState } from "./client-state";
import { DraftMigration } from "./DraftMigration";
import { StructureMigration } from "./StructureMigration";
import { SurfaceContents } from "./SurfaceContents";
import { SurfaceActions } from "./SurfaceActions";
import styles from "./IntelligentUiSurface.module.css";

export interface IntelligentUiSurfaceProps {
  payload: unknown;
  snapshot: string;
  sessionId?: string;
  toolCallId: string;
  entryId?: string;
  branchKey?: string;
  readOnly?: boolean;
  envelopeVersion?: number;
}

const baseMessages = {
  en: { loading: "Loading saved values…", saved: "Saved · available to your next message", saving: "Saving…", error: "Could not save or load values. Your local changes are retained.", retry: "Retry", conflict: "This answer changed in another branch or window. Your edits are kept; choose which values to use.", keep: "Save my values", reload: "Load saved values", invalid: "Enter a value within the allowed range.", preview: "Preview · controls become available after this part is saved", unavailable: "Interactive view unavailable", calculation: "Cannot calculate with these values", chart: "Bar chart", discard: "Discard unsaved changes", candidate: "Preview · waiting for publication confirmation", aborted: "This preview was not published. Saved answers remain available.", superseded: "A newer version is available. This earlier version is read-only.", retain: "Keep the old draft and use saved parameters", retained: "The old draft is kept separately on this device. Follow-up messages use the latest saved parameters; this draft has not been applied to the new version.", viewDraft: "View retained drafts", refresh: "Refresh publication status", actionFailed: "This action could not finish. Your draft has been kept; try again." },
  "zh-CN": { loading: "正在加载已保存的参数…", saved: "已保存 · 后续追问可读取当前参数", saving: "正在保存…", error: "参数加载或保存失败，本地调整已保留。", retry: "重试", conflict: "其他窗口或分支中的内容已变化。你的调整已保留，请选择使用哪份参数。", keep: "保存我的参数", reload: "加载已保存参数", invalid: "请输入允许范围内的值。", preview: "预览 · 此部分保存后即可操作", unavailable: "交互界面暂不可用", calculation: "当前参数无法计算", chart: "条形图", discard: "放弃未保存调整", candidate: "预览 · 正在等待发布确认", aborted: "此预览未发布，已保存的回答仍可查看。", superseded: "已有新版本，此旧版本仅供查看。", retain: "保留旧稿并使用已保存参数", retained: "旧稿已在本机单独保留。后续追问使用最新已保存参数；旧稿尚未应用到新版本。", viewDraft: "查看保留的旧稿", refresh: "刷新发布状态", actionFailed: "操作未完成，草稿仍已保留，请重试。" },
};
const messages = {
  en: { ...baseMessages.en, awaiting_confirmation: "Review changed fields before using this version" },
  "zh-CN": { ...baseMessages["zh-CN"], awaiting_confirmation: "核对字段变更后，才能使用此版本" },
};
type Copy = typeof messages.en;
const recoveryMessages = {
  en: { available: "Other recoverable drafts", notice: "These drafts are kept on this device. They are not applied to this window's parameters. Choose a draft to review a separate copy.", restore: "Restore this draft", retain: "Keep this draft", kept: "A separate copy is already retained" },
  "zh-CN": { available: "其他可恢复草稿", notice: "这些草稿保存在本机，尚未应用到此窗口的参数。选择恢复后可核对一份独立副本。", restore: "恢复这份草稿", retain: "保留这份草稿", kept: "已单独保留副本" },
};

function InteractiveSurface({ store, copy, branchKey }: { store: SurfaceState; copy: Copy; branchKey?: string }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [actionError, setActionError] = useState(false);
  const recoveryCopy = copy === messages.en ? recoveryMessages.en : recoveryMessages["zh-CN"];
  const migrateLabel = copy === messages.en ? "Review and migrate to the latest version" : "核对并迁移到新版本";
  useEffect(() => { void store.load(true); }, [store, branchKey]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void store.load(true); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("storage", store.refreshLocalDrafts);
    return () => { document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); window.removeEventListener("storage", store.refreshLocalDrafts); };
  }, [store]);
  useEffect(() => {
    if (view.publication?.status !== "candidate") return;
    let cancelled = false, attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const delays = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000];
    const poll = () => {
      if (cancelled || attempt >= delays.length || store.getSnapshot().publication?.status !== "candidate") return;
      timer = setTimeout(() => {
        if (document.hidden) { poll(); return; }
        void store.load(true).finally(poll);
      }, delays[attempt++]);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [store, branchKey, view.publication?.status]);
  const act = (operation: () => Promise<void>) => { setActionError(false); void operation().catch(() => setActionError(true)); };
  const disabled = !store.isEditable();
  const unpublished = view.status === "candidate" || view.status === "awaiting_confirmation" || view.status === "aborted" || view.status === "superseded";
  return <section className={styles.surface} aria-label={view.surface.title}>
    <header className={styles.header}><h3>{view.surface.title}</h3><span className={styles.badge}>Intelligent UI</span></header>
    <SurfaceContents locale={copy === messages.en ? "en" : "zh-CN"} surface={view.surface} state={view.state} disabled={disabled} copy={copy} change={(id, value) => {
      try { store.change(id, value); setActionError(false); } catch { setActionError(true); }
    }} />
    {store.envelopeVersion === 2 && view.surface.version === 2 && view.publication?.status === "committed" ? <SurfaceActions key={branchKey} store={store} locale={copy === messages.en ? "en" : "zh-CN"} /> : null}
    <footer className={styles.footer}>
      {unpublished ? <div className={styles.notice}><span role="status" aria-live="polite">{copy[view.status]}</span>{view.hasPendingDraft ? <button type="button" onClick={() => act(store.retainDraft)}>{copy.retain}</button> : view.status === "candidate" ? <button type="button" onClick={() => act(() => store.load(true))}>{copy.refresh}</button> : null}</div> : view.status === "conflict" ? <div role="alert" className={styles.notice}><span>{copy.conflict}</span><div className={styles.actions}><button type="button" onClick={() => act(() => store.resolve(true))}>{copy.keep}</button><button type="button" onClick={() => act(() => store.resolve(false))}>{copy.reload}</button></div></div> : view.status === "error" ? <div role="alert" className={styles.notice}><span>{copy.error}</span><div className={styles.actions}><button type="button" onClick={() => act(store.retry)}>{copy.retry}</button>{view.leafId ? <button type="button" onClick={() => act(() => store.resolve(false))}>{copy.reload}</button> : null}</div></div> : <span role="status" aria-live="polite">{copy[view.status]}</span>}
      {actionError ? <span role="alert">{copy.actionFailed}</span> : null}
      {view.status === "awaiting_confirmation" ? <StructureMigration key={branchKey} store={store} english={copy === messages.en} /> : null}
      {view.status === "superseded" && view.hasPendingDraft ? <div className={styles.notice}><button type="button" onClick={() => act(() => store.prepareMigration())}>{migrateLabel}</button></div> : null}
      {view.migration ? <DraftMigration key={view.migration.id} review={view.migration} store={store} english={copy === messages.en} /> : null}
      {view.migrationSaved ? <p role="status">{copy === messages.en ? "Selected values are saved in the latest version. The original draft is retained." : "所选参数已保存到新版本，原稿仍在本机保留。"}</p> : null}
      {view.migrationFailed ? <p role="alert">{copy === messages.en ? "Migration did not finish. Your drafts are retained; review the latest version before retrying." : "迁移未完成，草稿仍已保留。请核对最新版本后重试。"}</p> : null}
      {view.status === "error" || view.status === "conflict" ? <div className={styles.notice}><button type="button" onClick={() => act(store.discard)}>{copy.discard}</button></div> : null}
      {unpublished && view.hasPendingDraft ? <div className={styles.notice}><button type="button" onClick={() => act(store.discard)}>{copy.discard}</button></div> : null}
      {view.recoverableDrafts.length ? <details className={styles.notice}><summary>{recoveryCopy.available}</summary><p>{recoveryCopy.notice}</p>{view.recoverableDrafts.map(draft => <div key={draft.id} data-recovery-draft={draft.id}><pre className={styles.snapshot}>{formatSnapshot(draft.surface, draft.state)}</pre><div className={styles.actions}><button type="button" onClick={() => act(() => store.restoreDraft(draft.id))}>{recoveryCopy.restore}</button>{view.retainedDrafts.some(kept => kept.sourceDraftId === draft.id && JSON.stringify(kept.state) === JSON.stringify(draft.state)) ? <span>{recoveryCopy.kept}</span> : <button type="button" onClick={() => act(() => store.retainRecovery(draft.id))}>{recoveryCopy.retain}</button>}</div></div>)}</details> : null}
      {view.retainedDrafts.length ? <details className={styles.notice}><summary>{copy.viewDraft}</summary><p>{copy.retained}</p>{view.retainedDrafts.map(draft => <div key={draft.id}><pre className={styles.snapshot}>{formatSnapshot(draft.surface, draft.state)}</pre><button type="button" onClick={() => act(() => store.restoreDraft(draft.id))}>{recoveryCopy.restore}</button>{view.status === "superseded" ? <button type="button" onClick={() => act(() => store.prepareMigration(draft.id))}>{migrateLabel}</button> : null}</div>)}</details> : null}
    </footer>
  </section>;
}

function ValidSurface({ surface, props, copy }: { surface: UiSurface; props: IntelligentUiSurfaceProps; copy: Copy }) {
  const { sessionId, toolCallId, readOnly, envelopeVersion } = props;
  const store = useMemo(() => !readOnly && sessionId ? surfaceState(sessionId, toolCallId, surface, envelopeVersion) : null, [sessionId, toolCallId, readOnly, surface, envelopeVersion]);
  if (store) return <InteractiveSurface store={store} copy={copy} branchKey={props.branchKey} />;
  return <section className={styles.surface} aria-label={surface.title}><header className={styles.header}><h3>{surface.title}</h3><span className={styles.badge}>Intelligent UI</span></header><SurfaceContents locale={copy === messages.en ? "en" : "zh-CN"} surface={surface} state={initialState(surface)} disabled change={() => {}} copy={copy} /><footer className={styles.footer}>{copy.preview}</footer></section>;
}

export default function IntelligentUiSurface(props: IntelligentUiSurfaceProps) {
  const { locale } = useI18n();
  const copy = messages[locale === "en" ? "en" : "zh-CN"];
  const surface = useMemo(() => { try { return validateSurface(props.payload); } catch { return null; } }, [props.payload]);
  if (!surface) return <section className={styles.surface}><p>{copy.unavailable}</p><pre className={styles.snapshot}>{props.snapshot}</pre></section>;
  return <ValidSurface surface={surface} props={props} copy={copy} />;
}
