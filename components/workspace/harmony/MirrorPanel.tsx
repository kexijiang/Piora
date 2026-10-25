"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useHarmonyLiveFrame } from "@/hooks/useHarmonyLiveFrame";
import { useHarmonyManualControl } from "@/hooks/useHarmonyManualControl";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { shortcutMatchesEvent, shouldPreserveApplicationShortcut } from "@/lib/keyboard-shortcuts";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { copyText } from "@/lib/clipboard";
import styles from "./MirrorPanel.module.css";

type Device = { serial: string; name?: string; state: string; generation: number; connectionIssue?: string; capabilities?: Record<string, boolean> };
type Recording = { serial: string; recordingId: string; ownerId: string; startedAt: string; systemRecorderStateUnknown?: boolean };
type State = { leases?: Array<{ serial: string; owner: { kind: "agent" | "manual"; id: string } }>; controls?: Array<{ serial: string; status: "stopping" | "recovering" }> };
type Artifact = { serial?: string; path: string; filename: string };
type Outcome = { id: string; status: string; phase?: string; error?: string; path?: string; recoveryPath?: string; finalized?: boolean };

async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const action = body && typeof body === "object" ? (body as { action?: string }).action : undefined;
  const budget = action === "stop_recording" || action === "retrieve_recording" ? 180_000 : action === "start_recording" ? 30_000 : body ? 25_000 : 15_000;
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  try {
    const response = await fetch(`/api/harmony/${path}`, { cache: "no-store", signal: controller.signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
    return data as T;
  } catch (error) {
    if (timedOut) throw new Error(action?.includes("recording") ? "Recording request timed out. Checking the current state; do not repeat a system recorder toggle." : "Device request timed out. Verify the result before retrying; state polling resumes automatically.");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function MirrorPanel({ active, maximized, onMaximizedChange, onSnapshot }: {
  active: boolean; maximized?: boolean; onMaximizedChange?: (value: boolean) => void; onSnapshot?: (value: number) => void;
}) {
  const { locale } = useI18n();
  const { bindings } = useApplicationShortcuts();
  const chinese = locale === "zh-CN";
  const text = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [serial, setSerial] = useState("");
  const [state, setState] = useState<State>({});
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [recovery, setRecovery] = useState<{ path: string; finalized: boolean } | null>(null);
  const seenOutcome = useRef("");
  const [zoom, setZoom] = useState("fit");
  const [quality, setQuality] = useState("video");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordPhase, setRecordPhase] = useState<"idle" | "starting" | "recording" | "saving">("idle");
  const [capturing, setCapturing] = useState(false);
  const [inputText, setInputText] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);
  const selected = devices.find(device => device.serial === serial);
  const online = selected?.state === "online";
  const contextKey = `${serial}:${selected?.generation}:${quality}:${active}`;
  const scope = useRef({ key: contextKey, epoch: 0 });
  if (scope.current.key !== contextKey) { scope.current.key = contextKey; scope.current.epoch++; }
  const context = `${contextKey}:${scope.current.epoch}`;
  const current = useRef(context); current.current = context;
  const screenshotPending = useRef(false);
  const recordingPending = useRef(false);
  const controlPending = useRef(false);
  const gesture = useRef<{ x: number; y: number; started: number; context: string } | null>(null);
  const { ensureControl, clearControl, canControl } = useHarmonyManualControl({ active, serial, online: Boolean(online),
    holder: state.leases?.find(item => item.serial === serial), chinese, controlStatus: state.controls?.find(item => item.serial === serial)?.status });
  useEffect(() => {
    // Media must not share the input lease owner: releasing a manual input
    // lease on hide must not stop the independently owned recording.
    const key = "piora-harmony-mirror-media-owner-v1";
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(key); } catch { /* In-memory ownership still works. */ }
    const id = stored && /^media:[A-Za-z0-9-]{1,80}$/.test(stored) ? stored : `media:${crypto.randomUUID()}`;
    setOwnerId(id);
    try { sessionStorage.setItem(key, id); } catch { /* Optional reload recovery. */ }
  }, []);
  useEffect(() => clearControl(), [selected?.generation, clearControl]);
  const live = useHarmonyLiveFrame({ active, enabled: Boolean(online), serial, generation: selected?.generation,
    canvasRef: canvas, chinese, preferFrames: quality === "frames", fallbackError: text("请检查设备授权与连接", "Check device authorization and connection") });
  const frameMatches = live.status === "live" && live.frame?.serial === serial && live.frame.generation === selected?.generation;
  useEffect(() => { setCapturing(false); gesture.current = null; }, [quality]);

  useEffect(() => {
    if (!active) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const payload = await request<{ devices: Device[]; state?: State }>("devices", controller.signal);
        if (disposed || !Array.isArray(payload.devices)) return;
        const next = payload.devices.filter(device => typeof device.serial === "string" && Number.isInteger(device.generation));
        setDevices(next); setState(payload.state ?? {});
        // A disappearing device stays selected. Never silently control another phone.
        setSerial(value => value || (next.length === 1 ? next[0].serial : next.filter(device => device.state === "online").length === 1 ? next.find(device => device.state === "online")!.serial : ""));
        setConnectionError(""); onSnapshot?.(Date.now());
      } catch (failure) { if (!disposed) setConnectionError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [active, onSnapshot]);

  useEffect(() => {
    setRecording(null); setRecordPhase("idle"); setCapturing(false); setError(""); setNotice(""); setSavedPath(""); setRecovery(null); setInputText(""); gesture.current = null; seenOutcome.current = "";
    if (!active || !serial) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const payload = await request<{ recording: Recording | null; recordingOutcome?: Outcome | null }>(`media?serial=${encodeURIComponent(serial)}`, controller.signal);
        if (!disposed && !recordingPending.current) {
          const outcome = payload.recordingOutcome;
          setRecording(payload.recording);
          if (payload.recording) setError(value => value.startsWith("Recording request timed out.") ? "" : value);
          setRecordPhase(payload.recording ? outcome?.phase === "saving" ? "saving" : "recording" : outcome && ["running", "queued"].includes(outcome.status) ? outcome.phase === "saving" ? "saving" : "starting" : "idle");
          const outcomeKey = outcome ? JSON.stringify([outcome.id, outcome.status, outcome.phase, outcome.error, outcome.recoveryPath, outcome.path]) : "";
          if (!payload.recording && outcome && outcomeKey !== seenOutcome.current && !["running", "queued"].includes(outcome.status)) {
            seenOutcome.current = outcomeKey;
            if (outcome.status === "completed" && outcome.path) { setSavedPath(outcome.path); setNotice(text("已保存：", "Saved: ") + outcome.path); setError(""); }
            else if (outcome.error) { setError(outcome.error); setRecovery(outcome.recoveryPath ? { path: outcome.recoveryPath, finalized: outcome.finalized === true } : null); }
          }
        }
      } catch { /* Preserve the known owner/state through transient transport failures. */ }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [active, serial, selected?.generation, text]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const media = useCallback(async (action: string) => {
    if (!serial || !ownerId) return;
    const capture = action === "capture_screenshot";
    const pending = capture ? screenshotPending : recordingPending;
    if (pending.current) return;
    pending.current = true;
    const expected = current.current;
    if (capture) setCapturing(true); else setRecordPhase(action === "start_recording" ? "starting" : "saving");
    try {
      const payload = await request<{ artifact?: Artifact; recording?: Recording }>("media", undefined,
        { action, serial, ownerId, ...(recording ? { recordingId: recording.recordingId } : {}) });
      if (current.current !== expected) return;
      if (payload.recording) { setRecording(payload.recording); setRecordPhase("recording"); }
      if (payload.artifact) {
        setSavedPath(payload.artifact.path); setNotice(text("已保存：", "Saved: ") + payload.artifact.path);
        if (!capture) { setRecording(null); setRecordPhase("idle"); }
      }
      setError("");
    } catch (failure) {
      if (current.current !== expected) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      if (!capture) setRecordPhase(recording ? "recording" : "idle");
      // No automatic start/stop retry: a lost reply may have dispatched a system toggle.
    } finally {
      pending.current = false;
      if (current.current === expected && capture) setCapturing(false);
    }
  }, [serial, ownerId, recording, text]);

  useEffect(() => {
    const binding = bindings["harmony.screenshot"];
    if (!active || !online || !binding) return;
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || shouldPreserveApplicationShortcut(event.target) || !shortcutMatchesEvent(event, binding)) return;
      event.preventDefault(); void media("capture_screenshot");
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active, online, bindings, media]);

  const control = async (body: Record<string, unknown>) => {
    if (!canControl || controlPending.current) return;
    const expected = current.current;
    controlPending.current = true;
    try {
      const leaseToken = await ensureControl();
      if (current.current !== expected) return;
      await request("action", undefined, { action: body.action, serial, leaseToken, ...body });
      if (current.current === expected) setError("");
    } catch (failure) { if (current.current === expected) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { controlPending.current = false; }
  };
  const stopDevice = async () => {
    const expected = current.current;
    clearControl();
    try { await request("action", undefined, { action: "stop_device", serial }); }
    catch (failure) { if (current.current === expected) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const openSaved = async () => {
    const expected = current.current;
    try { if (!await window.piDesktop?.openPath?.(savedPath)) throw new Error(text("文件无法打开，请检查保存路径", "Could not open the file; check the saved path")); }
    catch (failure) { if (current.current === expected) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.currentTarget.width - 1, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)),
      y: Math.max(0, Math.min(event.currentTarget.height - 1, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height)) };
  };
  const status = !serial ? text("连接一台设备以自动投屏", "Connect a device to start mirroring")
    : selected?.state === "unauthorized" ? text("请在手机上允许调试授权", "Allow debugging on the phone")
    : selected?.connectionIssue === "hdc-channel-not-ready" ? text("等待调试通道；请检查连接并在手机确认调试授权", "Waiting for debugging communication; check the connection and phone authorization")
    : !online ? text("设备已断开，等待原设备重新连接", "Disconnected. Waiting for the same device")
    : frameMatches ? live.mode === "frames" ? text("标准画面", "Standard view") : text("已连接", "Connected")
    : text("正在连接；请解锁手机并确认屏幕共享授权", "Connecting. Unlock the phone and confirm screen-sharing consent");
  const ownsRecording = recording?.ownerId === ownerId;
  const elapsed = recording ? Math.max(0, Math.floor((clock - Date.parse(recording.startedAt)) / 1000)) : 0;

  return <section className={styles.root} aria-label={text("鸿蒙投屏", "Harmony mirror")}>
    <header className={styles.toolbar}>
      {devices.length > 1 || (!selected && devices.length > 0) ? <select aria-label={text("设备", "Device")} value={serial} disabled={Boolean(recording) || recordPhase !== "idle"} onChange={event => { clearControl(); setSerial(event.target.value); setZoom("fit"); }}>
        {!serial ? <option value="">{text("选择设备", "Select device")}</option> : null}
        {serial && !selected ? <option value={serial}>{serial}</option> : null}
        {devices.map(device => <option key={device.serial} value={device.serial}>{device.name || device.serial}</option>)}
      </select> : null}
      <select aria-label={text("缩放", "Zoom")} value={zoom} onChange={event => setZoom(event.target.value)}>
        <option value="fit">{text("适应窗口", "Fit")}</option>{[50, 100, 150, 200].map(value => <option key={value} value={String(value)}>{value}%</option>)}
      </select>
      <button disabled={!online || capturing} onClick={() => void media("capture_screenshot")}>{capturing ? text("截图中…", "Capturing…") : text("截图", "Screenshot")}</button>
      <button disabled={!online || !ownerId || recordPhase === "starting" || recordPhase === "saving" || Boolean(recording && !ownsRecording)} onClick={() => void media(recording ? recording.systemRecorderStateUnknown ? "retrieve_recording" : "stop_recording" : "start_recording")}>
        {recordPhase === "saving" ? text("正在保存…", "Saving…") : recordPhase === "starting" ? text("正在开始…", "Starting…") : recording ? recording.systemRecorderStateUnknown ? text("已在手机停止，取回录屏", "Stopped on phone · retrieve") : text(`停止录屏 ${elapsed}s`, `Stop recording ${elapsed}s`) : text("录屏", "Record")}
      </button>
    </header>
    <div className={styles.viewport}>
      <canvas ref={canvas} tabIndex={0} role="img" aria-label={text("实时投屏；点击或拖动操作设备", "Live mirror; click or drag to control device")} style={zoom === "fit" ? undefined : { width: (live.frame?.width ?? 0) * Number(zoom) / 100, height: (live.frame?.height ?? 0) * Number(zoom) / 100, maxWidth: "none", maxHeight: "none" }}
        onPointerDown={event => { if (event.button !== 0 || !live.frame?.geometryId || !frameMatches) return; event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { ...point(event), started: performance.now(), context }; }}
        onPointerCancel={() => { gesture.current = null; }}
        onPointerUp={event => {
          const start = gesture.current; gesture.current = null;
          if (!start || start.context !== current.current || !live.frame?.geometryId || !frameMatches) return;
          const end = point(event), distance = Math.hypot(end.x - start.x, end.y - start.y);
          void control({ action: distance < 8 ? "tap" : "drag", ...(distance < 8 ? end : { fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, durationMs: Math.min(10000, Math.max(50, performance.now() - start.started)) }), coordinateSpace: "frame", geometryId: live.frame.geometryId, generation: selected?.generation });
        }}
        onKeyDown={event => { if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); void control({ action: "press_key", key: event.key === "Escape" ? "back" : "enter" }); } }} />
      {live.status !== "live" ? <p className={styles.empty} role="status">{status}</p> : null}
    </div>
    <footer className={styles.status}>
      <span role="status">{status}</span>
      <details><summary>{text("操控", "Controls")}</summary><div className={styles.controls}>
        <select aria-label={text("画面模式", "View mode")} value={quality} onChange={event => setQuality(event.target.value)}><option value="video">{text("流畅", "Fluent")}</option><option value="frames">{text("标准", "Standard")}</option></select>
        {onMaximizedChange ? <button onClick={() => onMaximizedChange(!maximized)}>{text("展开 / 还原", "Expand / restore")}</button> : null}
        {(["back", "home", "recents"] as const).map(key => <button key={key} disabled={!canControl} onClick={() => void control({ action: "press_key", key })}>{key}</button>)}
        {(["power", "volume_down", "volume_up"] as const).map(key => <button key={key} disabled={!canControl} onClick={() => void control({ action: "key_hold", key, durationMs: 100 })}>{key}</button>)}
        <input aria-label={text("输入文本", "Input text")} value={inputText} onChange={event => setInputText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void control({ action: "input_text", text: inputText }); }} />
        <button disabled={!canControl || !inputText} onClick={() => void control({ action: "input_text", text: inputText })}>{text("发送文本", "Send text")}</button>
        <button disabled={!online} title={text("会停止此设备正在进行的任务及录屏", "Stops this device's active tasks, including recording")} onClick={() => void stopDevice()}>{text("停止此设备任务", "Stop device tasks")}</button>
      </div></details>
    </footer>
    {recording ? <small>{recording.systemRecorderStateUnknown ? text("系统录屏状态未知，请先在手机上停止再取回。不会重复切换录屏。", "System recording state unknown. Stop it on the phone before retrieval; no toggle will be retried.") : text("单次录屏上限 2 分钟 / 256 MiB；旋转或断线会结束并尝试保存已有内容。", "Recording limit: 2 min / 256 MiB. Rotation or disconnection ends recording and attempts to save captured content.")}</small> : null}
    {notice ? <p role="status">{notice}{savedPath && window.piDesktop?.openPath ? <button onClick={() => void openSaved()}>{text("打开文件", "Open file")}</button> : null}</p> : null}
    {error || connectionError || live.error ? <p role="alert">{error || connectionError || live.error}</p> : null}
    {recovery ? <p role="status">{recovery.finalized ? text("可恢复的视频已保留，请手动复制到安全位置：", "Finalized recovery video retained. Copy it to a safe location: ") : text("未完成封装的录屏文件已保留，不保证可播放或修复：", "Unfinalized recording retained; playback or repair is not guaranteed: ")}{recovery.path}<button onClick={() => { const expected = current.current; void copyText(recovery.path).catch(() => { if (current.current === expected) setError(text("复制路径失败，请手动复制", "Copy failed; select the path manually")); }); }}>{text("复制恢复路径", "Copy recovery path")}</button></p> : null}
    {online && live.status !== "live" ? <small>{text("如缺少投屏组件，请完成首次准备；投屏不会自动安装、唤醒或解锁手机。", "If the capture component is missing, complete initial setup. Viewing never installs, wakes or unlocks the phone.")}</small> : null}
  </section>;
}
