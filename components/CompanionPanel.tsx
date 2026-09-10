"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCompletionNotification } from "@/hooks/useCompletionNotification";
import { useRunningTaskSnapshots } from "@/hooks/useTaskStatus";
import {
  getCompanionFocusRemainingSeconds,
  pauseCompanionFocusTimer,
  resetCompanionFocusTimer,
  selectCompanionFocusPhase,
  startCompanionFocusTimer,
  updateCompanionFocusDuration,
} from "@/lib/companion-focus-timer";
import {
  COMPANION_RUNTIME_POLL_INTERVAL_MS,
  createCompanionRuntimeChannel,
  fetchCompanionRuntimeState,
  publishCompanionRuntimeState,
  saveCompanionRuntimeState,
} from "@/lib/companion-runtime-client";
import type { ModelsData } from "@/lib/models-cache";
import type { CompanionFocusTimerPhase, CompanionRuntimeState } from "@/lib/companion-runtime";
import {
  type CompanionInteractionModel,
} from "@/lib/companion-store";
import { CompanionToolLauncher } from "./CompanionToolLauncher";
import { CompanionTodoList } from "./CompanionTodoList";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./CompanionPanel.module.css";
import { CompanionTransferStation } from "./CompanionTransferStation";
import { useTransferStation } from "@/hooks/useTransferStation";

const JsonWorkbench = dynamic(() => import("./JsonWorkbench").then((module) => module.JsonWorkbench), { loading: () => <p role="status">正在打开 JSON 工具…</p> });
const ClipboardWorkbench = dynamic(() => import("./ClipboardWorkbench").then((module) => module.ClipboardWorkbench), { loading: () => <p role="status">正在打开剪贴板…</p> });
type Tab = "home" | "json" | "clipboard" | "now" | "tasks" | "focus" | "library" | "memory" | "mind";
const TOOLS: Array<{ id: Tab; icon: AliIconName; label: string; description: string; keywords: string }> = [
  { id: "clipboard", icon: "copy", label: "剪贴板", description: "查找复制历史，粘贴回原应用", keywords: "剪贴板 clipboard 历史 复制 粘贴 图片 收藏" },
  { id: "json", icon: "code", label: "JSON 工具", description: "格式化、校验与文本转换", keywords: "json 格式化 转换 base64 url unicode" },
  { id: "tasks", icon: "check-circle", label: "待办清单", description: "记下要做的，一件件完成", keywords: "任务 待办 todo" },
  { id: "focus", icon: "timer", label: "专注时钟", description: "留一段时间，只做一件事", keywords: "番茄钟 专注 focus timer" },
  { id: "library", icon: "archive", label: "中转站", description: "可视化 Markdown、表格与图片编辑", keywords: "中转 markdown 编辑 写作 文档 暂存 收藏 资料 笔记 代码 图片 表格" },
];

function emptyRuntimeState(): CompanionRuntimeState {
  return {
    version: 3,
    updatedAt: 0,
    migratedFromLocalStorage: false,
    settings: {
      interactionModel: null,
      shareWorkContext: true,
      autonomyLevel: "balanced",
      autonomyPaused: false,
      personality: "温暖、聪明、克制；关注事实，不打断专注。",
      quietHours: { enabled: false, start: "22:30", end: "08:00" },
      allowMovement: true,
      allowProactiveSpeech: true,
      autoCaptureSessions: true,
    },
    todos: [],
    taskRecords: [],
    focusTimer: {
      phase: "focus",
      status: "idle",
      durations: { focus: 25 * 60, "short-break": 5 * 60, "long-break": 15 * 60 },
      longBreakEvery: 4,
      autoStartNextPhase: false,
      petReminderEnabled: true,
      durationSeconds: 25 * 60,
      remainingSeconds: 25 * 60,
      startedAt: null,
      endsAt: null,
      linkedTodoId: null,
      completedFocusSessions: 0,
    },
    library: [],
    memories: [],
    mind: { mood: "calm", lastDecision: null, decisionHistory: [], nextWakeAt: null },
  };
}

function formatTime(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未安排";
}

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const FOCUS_PHASE_LABELS: Record<CompanionFocusTimerPhase, string> = {
  focus: "专注",
  "short-break": "短休息",
  "long-break": "长休息",
};

function modelValue(model: CompanionInteractionModel | null): string {
  return model ? JSON.stringify(model) : "";
}

function parseModelValue(value: string): CompanionInteractionModel | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Partial<CompanionInteractionModel>;
  return typeof parsed.provider === "string" && typeof parsed.modelId === "string"
    ? { provider: parsed.provider, modelId: parsed.modelId }
    : null;
}

export function CompanionPanel() {
  const [tab, setTab] = useState<Tab>("home");
  const [jsonOpened, setJsonOpened] = useState(false);
  const [libraryOpened, setLibraryOpened] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useCallback((next: Tab) => { setTab(next); if (next === "json") setJsonOpened(true); if (next === "library") setLibraryOpened(true); }, []);
  useEffect(() => window.piDesktop?.onMenuAction?.((action) => { if (action === "clipboard-history") navigate("clipboard"); }), [navigate]);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("tool") === "clipboard") navigate("clipboard"); }, [navigate]);
  const [state, setState] = useState<CompanionRuntimeState>(emptyRuntimeState);
  const [models, setModels] = useState<ModelsData | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const runtimeLoadedRef = useRef(false);
  const mutationPendingRef = useRef(false);
  const [modelDraft, setModelDraft] = useState("");
  const [modelSaveStatus, setModelSaveStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [question, setQuestion] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  const [personalityDraft, setPersonalityDraft] = useState("");
  const [personalityDirty, setPersonalityDirty] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const completedTimerEndRef = useRef<number | null>(null);
  const runtimeChannelRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);
  const runningTasks = useRunningTaskSnapshots();
  const { notifyCompletion } = useCompletionNotification();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest(".pocket-markdown-editor")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); navigate("home");
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  const transfer = useTransferStation(jsonOpened || libraryOpened || tab === "clipboard");

  const applyState = useCallback((next: CompanionRuntimeState) => {
    if (next.updatedAt < stateRef.current.updatedAt) return false;
    runtimeLoadedRef.current = true;
    setRuntimeError("");
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchCompanionRuntimeState({ signal });
    if (applyState(next)) publishCompanionRuntimeState(runtimeChannelRef.current, next);
  }, [applyState]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshPending = false;
    const refreshIfVisible = async () => {
      if (document.visibilityState === "hidden" || refreshPending) return;
      refreshPending = true;
      try {
        await refresh(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) setRuntimeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        refreshPending = false;
      }
    };
    const channel = createCompanionRuntimeChannel(applyState);
    runtimeChannelRef.current = channel;
    void refreshIfVisible();
    const pollTimer = window.setInterval(() => void refreshIfVisible(), COMPANION_RUNTIME_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      controller.abort();
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      if (runtimeChannelRef.current === channel) runtimeChannelRef.current = null;
      channel?.close();
    };
  }, [applyState, refresh]);

  useEffect(() => {
    if (tab !== "mind" || models) return;
    const controller = new AbortController();
    void fetch("/api/models", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ModelsData>;
      })
      .then((data) => {
        setModels(data);
        setModelsError(data.modelError ?? "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setModelsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [models, tab]);

  const mutate = useCallback(async (update: (current: CompanionRuntimeState) => CompanionRuntimeState) => {
    if (mutationPendingRef.current) return false;
    if (!runtimeLoadedRef.current) { setError("本地数据尚未加载，请稍后重试。"); return false; }
    mutationPendingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await saveCompanionRuntimeState(update(stateRef.current));
      if (applyState(next)) publishCompanionRuntimeState(runtimeChannelRef.current, next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      mutationPendingRef.current = false;
      setBusy(false);
    }
  }, [applyState]);

  const savedModelValue = modelValue(state.settings.interactionModel);
  useEffect(() => {
    if (modelSaveStatus === "dirty" || modelSaveStatus === "saving") return;
    setModelDraft(savedModelValue);
  }, [modelSaveStatus, savedModelValue]);

  const saveModel = useCallback(async () => {
    let interactionModel: CompanionInteractionModel | null;
    try {
      interactionModel = parseModelValue(modelDraft);
    } catch {
      setError("互动模型配置无效，请重新选择。");
      return;
    }
    setModelSaveStatus("saving");
    const saved = await mutate((current) => ({
      ...current,
      settings: { ...current.settings, interactionModel },
    }));
    setModelSaveStatus(saved ? "saved" : "dirty");
  }, [modelDraft, mutate]);

  useEffect(() => {
    if (!personalityDirty) setPersonalityDraft(state.settings.personality);
  }, [personalityDirty, state.settings.personality]);

  const savePersonalityDraft = useCallback(async () => {
    if (!personalityDirty) return;
    const personality = personalityDraft;
    const saved = await mutate((current) => ({
      ...current,
      settings: { ...current.settings, personality },
    }));
    if (saved) setPersonalityDirty(false);
  }, [mutate, personalityDirty, personalityDraft]);

  useEffect(() => {
    if (state.focusTimer.status !== "running") return;
    const updateClock = () => setClock(Date.now());
    updateClock();
    const timer = setInterval(updateClock, 1_000);
    return () => clearInterval(timer);
  }, [state.focusTimer.status, state.focusTimer.endsAt]);

  useEffect(() => {
    const timer = state.focusTimer;
    if (timer.status !== "running" || timer.endsAt === null || timer.endsAt > clock) return;
    if (completedTimerEndRef.current === timer.endsAt) return;
    completedTimerEndRef.current = timer.endsAt;
    const completedPhase = timer.phase;
    const linkedTask = state.todos.find((item) => item.id === timer.linkedTodoId)?.text;
    void (async () => {
      try {
        const response = await fetch("/api/companion/focus-timer/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const payload = await response.json().catch(() => null) as {
          completed?: boolean;
          state?: CompanionRuntimeState;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        if (payload?.state) applyState(payload.state);
        if (payload?.completed) {
          void notifyCompletion(linkedTask || (completedPhase === "focus" ? "番茄钟专注完成" : "休息结束"));
        }
      } catch (cause) {
        completedTimerEndRef.current = null;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [applyState, clock, notifyCompletion, state.focusTimer, state.todos]);

  const ask = async () => {
    if (busy || !question.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/companion/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "user.ask", question, locale: "zh-CN" }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setQuestion("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const saveJsonResult = (result: { content: string; language: string; title: string }) => transfer.mutate("POST", { ...result, kind: "code" }, true);

  const addMemory = async () => {
    const text = memoryDraft.trim();
    if (busy || !text) return;
    const now = Date.now();
    const saved = await mutate((current) => ({
      ...current,
      memories: [{ id: `memory:${crypto.randomUUID()}`, text, source: "user", createdAt: now, updatedAt: now }, ...current.memories],
    }));
    if (saved) setMemoryDraft("");
  };

  const activeTasks = useMemo(() => state.todos.filter((item) => !item.completed), [state.todos]);
  const pendingRecords = useMemo(() => state.taskRecords.filter((item) => item.reviewStatus === "pending"), [state.taskRecords]);
  const confirmedRecords = useMemo(() => state.taskRecords.filter((item) => item.reviewStatus === "confirmed"), [state.taskRecords]);
  const focusRemainingSeconds = getCompanionFocusRemainingSeconds(state.focusTimer, clock);
  const tabs: Array<{ id: Tab; icon: AliIconName; label: string }> = [
    { id: "home", icon: "home", label: "工具台" },
    { id: "json", icon: "code", label: "JSON" },
    { id: "clipboard", icon: "copy", label: "剪贴板" },
    { id: "tasks", icon: "check-circle", label: "待办" },
    { id: "focus", icon: "timer", label: "专注" },
    { id: "library", icon: "archive", label: "中转站" },
    { id: "now", icon: "heart", label: "陪伴" },
    { id: "memory", icon: "brain", label: "记忆" },
    { id: "mind", icon: "setting", label: "设置" },
  ];
  const activeTabLabel = tabs.find((item) => item.id === tab)?.label;

  return (
    <main className={`${styles.panel} companion-panel-root`} aria-busy={busy}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><Image className={styles.brandMark} src="/icons/icon-192.png" width={34} height={34} alt="Piora" unoptimized /><span>随身舱<small>PIORA POCKET</small></span></div>
        <nav className={styles.tabs} role="tablist" aria-orientation="vertical" aria-label="随身舱功能" onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = tabs.findIndex((item) => item.id === tab);
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
          navigate(tabs[next].id); document.getElementById(`cabin-tab-${tabs[next].id}`)?.focus();
        }}>
          {tabs.map(({ id, icon, label }) => <button type="button" role="tab" id={`cabin-tab-${id}`} aria-controls="cabin-content" tabIndex={tab === id ? 0 : -1} key={id} aria-selected={tab === id} data-active={tab === id} data-secondary={id === "now"} onClick={() => navigate(id)}><AliIcon name={icon} size={18} /><span>{label}</span>{id === "tasks" && activeTasks.length > 0 ? <small>{activeTasks.length}</small> : null}</button>)}
        </nav>
        <span className={styles.sidebarFoot}>随开 · 随用</span>
      </aside>
      <div className={styles.workspace}>
      <header className={styles.topbar}><span>{activeTabLabel}</span><button type="button" onClick={() => { navigate("home"); requestAnimationFrame(() => searchRef.current?.focus()); }} aria-label="搜索工具 Ctrl+K"><AliIcon name="search" size={15} /><kbd>Ctrl K</kbd></button></header>
      {error || (runtimeError && tab !== "json") ? <div className={styles.error} role="alert"><span>{error || runtimeError}</span>{error ? <button type="button" onClick={() => setError("")} aria-label="关闭错误提示">×</button> : <button type="button" onClick={() => void refresh().catch((cause: unknown) => setRuntimeError(cause instanceof Error ? cause.message : String(cause)))}>重试</button>}</div> : null}
      <section id="cabin-content" className={styles.content} data-tool={tab} role="tabpanel" aria-labelledby={`cabin-tab-${tab}`}>
        {tab === "home" ? <div className={styles.home}>
          <div className={styles.welcome}><h1>随身工具，顺手就好。</h1><p>找到工具，开始手边的小事。</p></div>
          <CompanionToolLauncher tools={TOOLS} searchRef={searchRef} onOpen={(id) => navigate(id as Tab)} />
          <button type="button" className={styles.todayStrip} onClick={() => navigate(state.focusTimer.status === "running" ? "focus" : "tasks")}><span className={styles.statusDot} /><span>{state.focusTimer.status === "running" ? `正在专注 · ${formatCountdown(focusRemainingSeconds)}` : activeTasks.length ? `今天还有 ${activeTasks.length} 件小事，慢慢来。` : "清单很轻，随时开始新的一件事。"}</span><AliIcon name="chevron-right" size={16} /></button>
        </div> : null}
        {jsonOpened ? <div className={styles.jsonPane} hidden={tab !== "json"}><JsonWorkbench busy={transfer.pending} library={transfer.items} onSaveResult={saveJsonResult} /></div> : null}
        {tab === "now" ? <>
          <div className={styles.pageHeading}><div><h1>陪伴</h1><p>听听你的想法，也记得留一点时间给自己。</p></div></div>
          <article className={styles.hero}>
            <span>刚才的想法</span>
            <h2>{state.mind.lastDecision?.thoughtSummary || "我正在安静陪伴，等待新的工作信号。"}</h2>
            {state.mind.lastDecision?.speech ? <blockquote>{state.mind.lastDecision.speech}</blockquote> : null}
          </article>
          <div className={styles.grid}>
            <article className={styles.card}><b>待办</b><strong>{activeTasks.length}</strong><small>项未完成</small></article>
            <article className={styles.card}><b>番茄钟</b><strong>{formatCountdown(focusRemainingSeconds)}</strong><small>{FOCUS_PHASE_LABELS[state.focusTimer.phase]} · {state.focusTimer.status === "running" ? "进行中" : state.focusTimer.status === "paused" ? "已暂停" : "待开始"}</small></article>
          </div>
          {pendingRecords.length ? <article className={styles.card}><b>有 {pendingRecords.length} 条会话任务待确认</b><button type="button" onClick={() => navigate("tasks")}>去待办查看</button></article> : null}
          <details className={styles.disclosure}>
            <summary>查看陪伴上下文</summary>
            <ul>{state.mind.lastDecision?.observedFacts.length ? state.mind.lastDecision.observedFacts.map((fact) => <li key={fact}>{fact}</li>) : <li>尚无可用的工作上下文</li>}</ul>
          </details>
          <div className={styles.composer}><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void ask(); }} placeholder="问问你的桌宠……" /><button type="button" disabled={busy || !question.trim()} onClick={() => void ask()}>发送</button></div>
        </> : null}

        <div hidden={tab !== "tasks"}>
          <CompanionTodoList todos={state.todos} busy={busy} onChange={(update) => mutate((current) => ({ ...current, todos: update(current.todos) }))} />
          {runningTasks.length ? <article className={styles.card}><b>正在运行的 Piora 任务</b><div className={styles.agentTasks}>{runningTasks.map((task) => <div key={task.id}><strong>{task.title || task.taskRun?.objective || task.id.slice(0, 8)}</strong><span>{task.activity?.message || task.taskRun?.progress || task.runtime}</span></div>)}</div></article> : null}
          <details className={styles.disclosure}><summary>自动记录设置</summary>
            <label className={styles.toggle}>
              <input type="checkbox" checked={state.settings.autoCaptureSessions} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, autoCaptureSessions: !current.settings.autoCaptureSessions } }))} />
              自动记录已完成的会话任务
            </label>
            <p className={styles.hint}>只在本地读取最近一轮问题和最终答复；结果先进入待确认，不读取思维过程、工具输出或完整历史。</p>
          </details>
          {pendingRecords.length ? <section className={styles.recordSection}>
            <h2>待确认 <span>{pendingRecords.length}</span></h2>
            <div className={styles.list}>{pendingRecords.map((record) => <article className={styles.record} key={record.id}>
              <div className={styles.recordHeading}><span>自动提取</span><small>{formatTime(record.completedAt)}</small></div>
              <b>{record.title}</b>
              <p>{record.outcome}</p>
              <small>{[record.project, record.sessionTitle].filter(Boolean).join(" · ")}</small>
              <div className={styles.itemActions}>
                <button onClick={() => void mutate((current) => ({ ...current, taskRecords: current.taskRecords.map((item) => item.id === record.id ? { ...item, reviewStatus: "confirmed", updatedAt: Date.now() } : item) }))}>确认记录</button>
                <button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, taskRecords: current.taskRecords.map((item) => item.id === record.id ? { ...item, reviewStatus: "dismissed", updatedAt: Date.now() } : item) }))}>忽略</button>
              </div>
            </article>)}</div>
          </section> : null}
          {confirmedRecords.length ? <section className={styles.recordSection}>
            <h2>已记录 <span>{confirmedRecords.length}</span></h2>
            <div className={styles.list}>{confirmedRecords.map((record) => <article className={styles.record} key={record.id}>
              <div className={styles.recordHeading}><span>会话记录</span><small>{formatTime(record.completedAt)}</small></div>
              <b>{record.title}</b><p>{record.outcome}</p>
              <div className={styles.itemActions}><button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, taskRecords: current.taskRecords.filter((item) => item.id !== record.id) }))}>删除记录</button></div>
            </article>)}</div>
          </section> : null}
        </div>

        {tab === "focus" ? <>
          <div className={styles.pageHeading}><div><h1>专注</h1><p>专注一会儿，也记得好好休息。</p></div></div>
          <article className={styles.timerCard}>
            <div className={styles.phaseTabs}>{(["focus", "short-break", "long-break"] as const).map((phase) => <button key={phase} data-active={state.focusTimer.phase === phase} disabled={state.focusTimer.status === "running"} onClick={() => void mutate((current) => ({ ...current, focusTimer: selectCompanionFocusPhase(current.focusTimer, phase) }))}>{FOCUS_PHASE_LABELS[phase]}</button>)}</div>
            <span className={styles.timerLabel}>{FOCUS_PHASE_LABELS[state.focusTimer.phase]}</span>
            <strong className={styles.timerValue}>{formatCountdown(focusRemainingSeconds)}</strong>
            <small>已完成 {state.focusTimer.completedFocusSessions} 个专注番茄；每 {state.focusTimer.longBreakEvery} 个自动安排一次长休息。</small>
            <label className={styles.timerTask}>绑定待办<select value={state.focusTimer.linkedTodoId ?? ""} onChange={(event) => void mutate((current) => ({ ...current, focusTimer: { ...current.focusTimer, linkedTodoId: event.target.value || null } }))}><option value="">不绑定任务</option>{activeTasks.map((task) => <option key={task.id} value={task.id}>{task.text}</option>)}</select></label>
            <div className={styles.timerActions}>
              {state.focusTimer.status === "running"
                ? <button className={styles.primary} onClick={() => void mutate((current) => ({ ...current, focusTimer: pauseCompanionFocusTimer(current.focusTimer) }))}>暂停</button>
                : <button className={styles.primary} onClick={() => void mutate((current) => ({ ...current, focusTimer: startCompanionFocusTimer(current.focusTimer) }))}>{state.focusTimer.status === "paused" ? "继续" : "开始"}</button>}
              <button onClick={() => void mutate((current) => ({ ...current, focusTimer: resetCompanionFocusTimer(current.focusTimer) }))}>重置</button>
            </div>
            <details className={styles.timerSettings} aria-label="番茄钟设置">
              <summary>时间与提醒设置</summary>
              <div className={styles.timerSettingsGrid}>
                {(["focus", "short-break", "long-break"] as const).map((phase) => <label key={phase}>
                  <span>{FOCUS_PHASE_LABELS[phase]}</span>
                  <span className={styles.numberInput}><input type="number" min="1" max="240" step="1" value={Math.round(state.focusTimer.durations[phase] / 60)} disabled={state.focusTimer.status === "running" && state.focusTimer.phase === phase} onChange={(event) => { const minutes = Number(event.target.value); if (!Number.isFinite(minutes)) return; void mutate((current) => ({ ...current, focusTimer: updateCompanionFocusDuration(current.focusTimer, phase, minutes * 60) })); }} /><small>分钟</small></span>
                </label>)}
                <label>
                  <span>长休息间隔</span>
                  <span className={styles.numberInput}><input type="number" min="1" max="12" step="1" value={state.focusTimer.longBreakEvery} onChange={(event) => { const value = Number(event.target.value); if (!Number.isFinite(value)) return; void mutate((current) => ({ ...current, focusTimer: { ...current.focusTimer, longBreakEvery: Math.max(1, Math.min(12, Math.round(value))) } })); }} /><small>轮</small></span>
                </label>
              </div>
              <label className={styles.toggle}><input type="checkbox" checked={state.focusTimer.autoStartNextPhase} onChange={() => void mutate((current) => ({ ...current, focusTimer: { ...current.focusTimer, autoStartNextPhase: !current.focusTimer.autoStartNextPhase } }))} />到点后自动开始下一阶段</label>
              <label className={styles.toggle}><input type="checkbox" checked={state.focusTimer.petReminderEnabled} onChange={() => void mutate((current) => ({ ...current, focusTimer: { ...current.focusTimer, petReminderEnabled: !current.focusTimer.petReminderEnabled } }))} />到点时让宠物提醒</label>
            </details>
          </article>
        </> : null}

        {libraryOpened ? <div className={styles.libraryPane} hidden={tab !== "library"}><CompanionTransferStation {...transfer} /></div> : null}
        {tab === "clipboard" ? <ClipboardWorkbench onSave={async (entry) => { await transfer.write("POST", { title: entry.title, content: entry.content, ...(entry.kind === "image" ? { kind: "image" } : { language: "markdown" }) }); }} /> : null}

        {tab === "memory" ? <>
          <div className={styles.pageHeading}><div><h1>记忆</h1><p>让陪伴更懂你一点。</p></div></div>
          <p className={styles.hint}>记忆只保存你明确留下的偏好或事实，可随时删除。</p>
          <div className={styles.composer}><input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void addMemory(); }} placeholder="例如：提醒我每 90 分钟休息" /><button type="button" disabled={busy || !memoryDraft.trim()} onClick={() => void addMemory()}>记住</button></div>
          <div className={styles.list}>{state.memories.map((item) => <article className={styles.row} key={item.id}><div><b>{item.text}</b><small>{formatTime(item.updatedAt)}</small></div><button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, memories: current.memories.filter((memory) => memory.id !== item.id) }))}>忘记</button></article>)}</div>
          {!state.memories.length ? <div className={styles.empty}><AliIcon name="brain" size={32} /><b>从记住一件小事开始</b><p>你的习惯、偏好，都可以留在这里。</p></div> : null}
        </> : null}

        {tab === "mind" ? <div className={styles.settings}>
          <div className={styles.pageHeading}><div><h1>设置</h1><p>陪伴方式、互动模型与本地存储。</p></div></div>
          <label>
            互动模型
            <div className={styles.modelSaveRow}>
              <select
                value={modelDraft}
                disabled={busy}
                onChange={(event) => {
                  setModelDraft(event.target.value);
                  setModelSaveStatus(event.target.value === savedModelValue ? "idle" : "dirty");
                }}
              >
                <option value="">请选择模型</option>
                {(() => {
                  let selected: CompanionInteractionModel | null = null;
                  try { selected = parseModelValue(modelDraft); } catch { /* invalid drafts are reported when saved */ }
                  return selected && !models?.modelList.some((model) => model.provider === selected?.provider && model.id === selected?.modelId)
                    ? <option value={modelDraft}>{selected.provider} · {selected.modelId}（当前范围不可用）</option>
                    : null;
                })()}
                {models?.modelList.map((model) => <option key={`${model.provider}:${model.id}`} value={JSON.stringify({ provider: model.provider, modelId: model.id })}>{model.provider} · {model.name || model.id}</option>)}
              </select>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || modelSaveStatus !== "dirty" || modelDraft === savedModelValue}
                onClick={() => void saveModel()}
              >
                {modelSaveStatus === "saving" ? "保存中…" : "保存模型"}
              </button>
            </div>
            {modelsError ? <small className={styles.modelError} role="alert">模型列表加载失败：{modelsError}</small> : null}
            <small className={styles.saveStatus} role="status" aria-live="polite">
              {modelSaveStatus === "saved" ? "模型已保存。" : modelSaveStatus === "dirty" ? "选择已更改，点击保存后生效。" : "选择不同的模型后，保存按钮会自动启用。"}
            </small>
          </label>
          <label>自主程度<select aria-label="自主程度" value={state.settings.autonomyLevel} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, autonomyLevel: event.target.value as "quiet" | "balanced" | "active" } }))}><option value="quiet">安静</option><option value="balanced">平衡</option><option value="active">活跃</option></select></label>
          <label>性格<textarea aria-label="性格" value={personalityDraft} onChange={(event) => { setPersonalityDraft(event.target.value); setPersonalityDirty(true); }} onBlur={() => void savePersonalityDraft()} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={!state.settings.autonomyPaused} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, autonomyPaused: !current.settings.autonomyPaused } }))} />允许自主观察</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.shareWorkContext} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, shareWorkContext: !current.settings.shareWorkContext } }))} />向互动模型发送汇总后的工作上下文</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.allowProactiveSpeech} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, allowProactiveSpeech: !current.settings.allowProactiveSpeech } }))} />允许任务变化或定时观察时主动说话</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.allowMovement} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, allowMovement: !current.settings.allowMovement } }))} />允许宠物自主随机移动</label>
          <p className={styles.hint}>关闭后会立即停止自主闲逛和任务联动移动，但仍可手动拖动宠物位置。</p>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.quietHours.enabled} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, enabled: !current.settings.quietHours.enabled } } }))} />启用安静时段</label>
          {state.settings.quietHours.enabled ? <div className={styles.quietHours}><label>开始<input type="time" value={state.settings.quietHours.start} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, start: event.target.value } } }))} /></label><span>至</span><label>结束<input type="time" value={state.settings.quietHours.end} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, end: event.target.value } } }))} /></label></div> : null}
          <article className={styles.card}><b>隐私说明</b><p>只发送任务标题、进度、工作时长和 Token 等汇总字段；不会把代码正文、文件内容或密钥自动发给互动模型。</p></article>
          <CompanionStorageSettings scope="library" compact />
          <CompanionStorageSettings scope="json" compact />
          <details className={styles.disclosure}><summary>其他数据位置</summary><CompanionStorageSettings compact /></details>
        </div> : null}
      </section>
      </div>
    </main>
  );
}
