"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  MAX_COMPANION_LIBRARY_ITEMS,
  createCompanionId,
  type CompanionInteractionModel,
  type CompanionLibraryKind,
} from "@/lib/companion-store";
import { JsonWorkbench } from "./JsonWorkbench";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./CompanionPanel.module.css";

type Tab = "now" | "tasks" | "focus" | "library" | "memory" | "mind";

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
  const [tab, setTab] = useState<Tab>("now");
  const [state, setState] = useState<CompanionRuntimeState>(emptyRuntimeState);
  const [models, setModels] = useState<ModelsData | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [modelSaveStatus, setModelSaveStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [question, setQuestion] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  const [personalityDraft, setPersonalityDraft] = useState("");
  const [personalityDirty, setPersonalityDirty] = useState(false);
  const [libraryTitle, setLibraryTitle] = useState("");
  const [libraryContent, setLibraryContent] = useState("");
  const [libraryKind, setLibraryKind] = useState<CompanionLibraryKind>("note");
  const [libraryView, setLibraryView] = useState<"library" | "json">("library");
  const [clock, setClock] = useState(() => Date.now());
  const completedTimerEndRef = useRef<number | null>(null);
  const runtimeChannelRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);
  const runningTasks = useRunningTaskSnapshots();
  const { notifyCompletion } = useCompletionNotification();

  const applyState = useCallback((next: CompanionRuntimeState) => {
    if (next.updatedAt < stateRef.current.updatedAt) return false;
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
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        refreshPending = false;
      }
    };
    const channel = createCompanionRuntimeChannel(applyState);
    runtimeChannelRef.current = channel;
    void refreshIfVisible();
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

  const mutate = useCallback(async (update: (current: CompanionRuntimeState) => CompanionRuntimeState) => {
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

  const addTask = async () => {
    const text = taskDraft.trim();
    if (busy || !text) return;
    const now = Date.now();
    const saved = await mutate((current) => ({
      ...current,
      todos: [{ id: createCompanionId("todo"), text, completed: false, progress: 0, createdAt: now, updatedAt: now }, ...current.todos],
    }));
    if (saved) setTaskDraft("");
  };

  const addLibraryItem = async () => {
    const title = libraryTitle.trim();
    const content = libraryContent.trim();
    if (busy || !title || !content) return;
    const now = Date.now();
    const saved = await mutate((current) => ({
      ...current,
      library: [{ id: createCompanionId("library"), kind: libraryKind, title, content, pinned: false, createdAt: now, updatedAt: now }, ...current.library],
    }));
    if (saved) {
      setLibraryTitle("");
      setLibraryContent("");
    }
  };

  const saveJsonResult = async (result: { content: string; language: string; title: string }) => {
    if (busy || stateRef.current.library.length >= MAX_COMPANION_LIBRARY_ITEMS) return false;
    const now = Date.now();
    return mutate((current) => ({
      ...current,
      library: [{
        id: createCompanionId("library"), kind: "code", title: result.title,
        content: result.content, language: result.language, pinned: false, createdAt: now, updatedAt: now,
      }, ...current.library],
    }));
  };

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
    { id: "now", icon: "home", label: "现在" },
    { id: "tasks", icon: "check", label: "任务" },
    { id: "focus", icon: "calendar", label: "番茄钟" },
    { id: "library", icon: "database", label: "资料" },
    { id: "memory", icon: "message", label: "记忆" },
    { id: "mind", icon: "robot", label: "心智" },
  ];
  const activeTabLabel = tabs.find((item) => item.id === tab)?.label;

  return (
    <main className={`${styles.panel} companion-panel-root`} aria-busy={busy}>
      <nav className={styles.tabs} role="tablist" aria-label="随身舱功能">
        {tabs.map(({ id, icon, label }) => <button type="button" role="tab" key={id} aria-selected={tab === id} data-active={tab === id} onClick={() => setTab(id)}><AliIcon name={icon} size={14} /><span>{label}</span></button>)}
      </nav>
      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.content} role="tabpanel" aria-label={activeTabLabel}>
        {tab === "now" ? <>
          <article className={styles.hero}>
            <span>刚才的想法</span>
            <h2>{state.mind.lastDecision?.thoughtSummary || "我正在安静陪伴，等待新的工作信号。"}</h2>
            {state.mind.lastDecision?.speech ? <blockquote>{state.mind.lastDecision.speech}</blockquote> : null}
          </article>
          <div className={styles.grid}>
            <article className={styles.card}><b>待办</b><strong>{activeTasks.length}</strong><small>项未完成</small></article>
            <article className={styles.card}><b>番茄钟</b><strong>{formatCountdown(focusRemainingSeconds)}</strong><small>{FOCUS_PHASE_LABELS[state.focusTimer.phase]} · {state.focusTimer.status === "running" ? "进行中" : state.focusTimer.status === "paused" ? "已暂停" : "待开始"}</small></article>
          </div>
          {pendingRecords.length ? <article className={styles.card}><b>有 {pendingRecords.length} 条会话任务待确认</b><p>去“任务”页检查宠物自动提取的记录。</p></article> : null}
          <article className={styles.card}>
            <b>我看见的事实</b>
            <ul>{state.mind.lastDecision?.observedFacts.length ? state.mind.lastDecision.observedFacts.map((fact) => <li key={fact}>{fact}</li>) : <li>尚无可用的工作上下文</li>}</ul>
          </article>
          <div className={styles.composer}><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void ask(); }} placeholder="问问你的桌宠……" /><button type="button" disabled={busy || !question.trim()} onClick={() => void ask()}>{question.trim() ? "发送" : "请输入问题"}</button></div>
        </> : null}

        {tab === "tasks" ? <>
          {runningTasks.length ? <article className={styles.card}><b>正在运行的 Piora 任务</b><div className={styles.agentTasks}>{runningTasks.map((task) => <div key={task.id}><strong>{task.title || task.taskRun?.objective || task.id.slice(0, 8)}</strong><span>{task.activity?.message || task.taskRun?.progress || task.runtime}</span></div>)}</div></article> : null}
          <article className={styles.card}>
            <label className={styles.toggle}>
              <input type="checkbox" checked={state.settings.autoCaptureSessions} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, autoCaptureSessions: !current.settings.autoCaptureSessions } }))} />
              自动记录已完成的会话任务
            </label>
            <p className={styles.hint}>只在本地读取最近一轮问题和最终答复；结果先进入待确认，不读取思维过程、工具输出或完整历史。</p>
          </article>
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
          <div className={styles.composer}><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addTask(); }} placeholder="添加一个待办任务" /><button type="button" disabled={busy || !taskDraft.trim()} onClick={() => void addTask()}>{taskDraft.trim() ? "添加" : "请输入任务"}</button></div>
          <div className={styles.list}>{state.todos.map((item) => <article className={styles.row} key={item.id}>
            <button className={styles.check} data-done={item.completed} onClick={() => void mutate((current) => ({ ...current, todos: current.todos.map((todo) => todo.id === item.id ? { ...todo, completed: !todo.completed, progress: !todo.completed ? 100 : 0, updatedAt: Date.now() } : todo) }))}>{item.completed ? "✓" : ""}</button>
            <div><b>{item.text}</b><label>进度 {item.progress}%<input type="range" min="0" max="100" value={item.progress} onChange={(event) => { const progress = Number(event.target.value); void mutate((current) => ({ ...current, todos: current.todos.map((todo) => todo.id === item.id ? { ...todo, progress, completed: progress === 100, updatedAt: Date.now() } : todo) })); }} /></label></div>
            <button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, todos: current.todos.filter((todo) => todo.id !== item.id) }))}>删除</button>
          </article>)}</div>
          {confirmedRecords.length ? <section className={styles.recordSection}>
            <h2>已记录 <span>{confirmedRecords.length}</span></h2>
            <div className={styles.list}>{confirmedRecords.map((record) => <article className={styles.record} key={record.id}>
              <div className={styles.recordHeading}><span>会话记录</span><small>{formatTime(record.completedAt)}</small></div>
              <b>{record.title}</b><p>{record.outcome}</p>
              <div className={styles.itemActions}><button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, taskRecords: current.taskRecords.filter((item) => item.id !== record.id) }))}>删除记录</button></div>
            </article>)}</div>
          </section> : null}
        </> : null}

        {tab === "focus" ? <>
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
            <section className={styles.timerSettings} aria-label="番茄钟设置">
              <b>时间设置</b>
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
            </section>
          </article>
          <article className={styles.card}><b>专注建议</b><p>专注阶段只做绑定任务；倒计时结束后会切换阶段{state.focusTimer.petReminderEnabled ? "，宠物也会来提醒你" : ""}。</p></article>
        </> : null}

        {tab === "library" ? <>
          <div className={styles.libraryModes} role="tablist" aria-label="资料功能">
            <button type="button" role="tab" aria-selected={libraryView === "library"} onClick={() => setLibraryView("library")}>资料架</button>
            <button type="button" role="tab" aria-selected={libraryView === "json"} onClick={() => setLibraryView("json")}>JSON 转</button>
          </div>
          {libraryView === "json" ? <JsonWorkbench busy={busy} library={state.library} onSaveResult={saveJsonResult} /> : <>
            <div className={styles.stack}><div className={styles.inline}><select value={libraryKind} onChange={(event) => setLibraryKind(event.target.value as CompanionLibraryKind)}><option value="note">笔记</option><option value="code">代码</option><option value="command">命令</option></select><input value={libraryTitle} onChange={(event) => setLibraryTitle(event.target.value)} placeholder="标题" /></div><textarea value={libraryContent} onChange={(event) => setLibraryContent(event.target.value)} placeholder="保存一段文字、代码或命令" /><button type="button" disabled={busy || !libraryTitle.trim() || !libraryContent.trim()} onClick={() => void addLibraryItem()}>{!libraryTitle.trim() ? "请填写标题" : !libraryContent.trim() ? "请填写内容" : "保存到资料架"}</button></div>
            <label className={styles.imageUpload}>保存一张图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (file.size > 1_250_000) { setError("图片不能超过 1.25 MB"); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result !== "string") return; const now = Date.now(); void mutate((current) => ({ ...current, library: [{ id: createCompanionId("library"), kind: "image", title: file.name.slice(0, 120), content: reader.result as string, pinned: false, createdAt: now, updatedAt: now }, ...current.library] })); }; reader.readAsDataURL(file); }} /></label>
            <div className={styles.list}>{state.library.map((item) => <article className={styles.libraryItem} key={item.id}><div><span>{item.kind}</span><b>{item.title}</b></div>{item.kind === "image" ? <span className={styles.libraryImage} role="img" aria-label={item.title} style={{ backgroundImage: `url(${JSON.stringify(item.content)})` }} /> : <pre>{item.content}</pre>}<div className={styles.itemActions}>{item.kind !== "image" ? <button onClick={() => void navigator.clipboard.writeText(item.content)}>复制</button> : null}<button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, library: current.library.filter((entry) => entry.id !== item.id) }))}>删除</button></div></article>)}</div>
          </>}
        </> : null}

        {tab === "memory" ? <>
          <p className={styles.hint}>记忆只保存你明确留下的偏好或事实，可随时删除。</p>
          <div className={styles.composer}><input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addMemory(); }} placeholder="例如：提醒我每 90 分钟休息" /><button type="button" disabled={busy || !memoryDraft.trim()} onClick={() => void addMemory()}>{memoryDraft.trim() ? "记住" : "请输入内容"}</button></div>
          <div className={styles.list}>{state.memories.map((item) => <article className={styles.row} key={item.id}><div><b>{item.text}</b><small>{formatTime(item.updatedAt)}</small></div><button className={styles.danger} onClick={() => void mutate((current) => ({ ...current, memories: current.memories.filter((memory) => memory.id !== item.id) }))}>忘记</button></article>)}</div>
        </> : null}

        {tab === "mind" ? <div className={styles.settings}>
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
          <label>自主程度<select value={state.settings.autonomyLevel} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, autonomyLevel: event.target.value as "quiet" | "balanced" | "active" } }))}><option value="quiet">安静</option><option value="balanced">平衡</option><option value="active">活跃</option></select></label>
          <label>性格<textarea value={personalityDraft} onChange={(event) => { setPersonalityDraft(event.target.value); setPersonalityDirty(true); }} onBlur={() => void savePersonalityDraft()} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={!state.settings.autonomyPaused} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, autonomyPaused: !current.settings.autonomyPaused } }))} />允许自主观察</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.shareWorkContext} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, shareWorkContext: !current.settings.shareWorkContext } }))} />向互动模型发送汇总后的工作上下文</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.allowProactiveSpeech} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, allowProactiveSpeech: !current.settings.allowProactiveSpeech } }))} />允许任务变化或定时观察时主动说话</label>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.allowMovement} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, allowMovement: !current.settings.allowMovement } }))} />允许宠物自主随机移动</label>
          <p className={styles.hint}>关闭后会立即停止自主闲逛和任务联动移动，但仍可手动拖动宠物位置。</p>
          <label className={styles.toggle}><input type="checkbox" checked={state.settings.quietHours.enabled} onChange={() => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, enabled: !current.settings.quietHours.enabled } } }))} />启用安静时段</label>
          {state.settings.quietHours.enabled ? <div className={styles.quietHours}><label>开始<input type="time" value={state.settings.quietHours.start} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, start: event.target.value } } }))} /></label><span>至</span><label>结束<input type="time" value={state.settings.quietHours.end} onChange={(event) => void mutate((current) => ({ ...current, settings: { ...current.settings, quietHours: { ...current.settings.quietHours, end: event.target.value } } }))} /></label></div> : null}
          <article className={styles.card}><b>隐私说明</b><p>只发送任务标题、进度、工作时长和 Token 等汇总字段；不会把代码正文、文件内容或密钥自动发给互动模型。</p></article>
          <CompanionStorageSettings compact />
        </div> : null}
      </section>
    </main>
  );
}
