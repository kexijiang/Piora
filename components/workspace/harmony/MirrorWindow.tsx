"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHarmonyWindow } from "@/hooks/useHarmonyWindow";
import { useHarmonyMirror } from "@/hooks/useHarmonyMirror";
import { useMirrorInput } from "@/hooks/useMirrorInput";
import { harmonyJson } from "@/lib/harmony/client";
import { useMirrorMedia } from "@/hooks/useMirrorMedia";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { isMacPlatform, shortcutMatchesEvent, shouldPreserveApplicationShortcut } from "@/lib/keyboard-shortcuts";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { showPioraMessage } from "@/components/PioraMessage";
import { AliIcon } from "@/components/AliIcon";
import { formatHarmonyDeviceTitle, formatHarmonyDeviceLabel } from "@/lib/harmony/device-label";
import styles from "./MirrorWindow.module.css";
import { MirrorViewControls } from "./MirrorViewControls";

type Device = { serial: string; name?: string; model?: string; product?: string; state: string; generation: number; capabilities: Record<string, boolean> };
export function MirrorWindow({ embedded = false, serial: embeddedSerial, active = true }: { embedded?: boolean; serial?: string; active?: boolean } = {}) {
  const { isDark } = useTheme();
  useFontPreferences();
  const { locale } = useI18n(); const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const state = useHarmonyWindow(); const serial = embedded ? embeddedSerial ?? "" : state?.serial ?? "";
  const [device, setDevice] = useState<Device | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const [controlEnabled, setControlEnabled] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  const [chromeHeight, setChromeHeight] = useState(85);
  useEffect(() => {
    const root = rootRef.current, screen = screenRef.current;
    if (!root || !screen) return;
    const observer = new ResizeObserver(() => setChromeHeight(Math.ceil(root.getBoundingClientRect().height - screen.getBoundingClientRect().height)));
    observer.observe(root); observer.observe(screen);
    return () => observer.disconnect();
  }, []);
  const [zoom, setZoom] = useState("fit");
  const { bindings } = useApplicationShortcuts();
  useEffect(() => {
    setDevice(null); setDeviceError(""); setControlEnabled(true); setZoom("fit"); if (!serial) return;
    const controller = new AbortController(); let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try { const data = await harmonyJson<{ devices: Device[] }>("/api/harmony/devices", undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
        if (!controller.signal.aborted) { setDevice(data.devices.find(item => item.serial === serial) ?? null); setDeviceError(""); }
      } catch (error) { if (!controller.signal.aborted) setDeviceError(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => { void load(); }, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [serial]);
  const presentation = embedded ? "sidebar" : "floating";
  const presenting = active && state?.serial === serial && Boolean(state?.open && ((state.presentation ?? "floating") === presentation || state.pendingPresentation === presentation));
  const currentDevice = device?.serial === serial ? device : null;
  const live = useHarmonyMirror({ active: presenting && currentDevice?.state === "online", serial,
    generation: currentDevice?.generation, label: copy("手机画面", "Device screen") });
  const input = useMirrorInput({ enabled: controlEnabled && live.state === "live" && presenting, frame: live.frame, chinese });
  const media = useMirrorMedia(serial, state?.ownerId ?? "", Boolean(serial), chinese);
  const canScreenshot = device?.state === "online" && device.capabilities?.screenshot;
  const width = live.frame?.width, height = live.frame?.height;
  useEffect(() => {
    if (presenting && live.state === "live" && live.frame?.serial === serial && width && height) void window.piDesktop?.harmonyMirror?.reportFrame({ serial, width, height, chromeHeight, presentation, transition: state?.presentationTransition });
  }, [serial, width, height, presenting, presentation, live.state, live.frame?.serial, state?.presentationTransition, chromeHeight]);
  const record = useCallback(() => {
    if (media.recording && !media.ownsRecording) return;
    void media.action(media.recording?.systemRecorderStateUnknown ? "retrieve_recording" : media.recording ? "stop_recording" : "start_recording");
  }, [media]);
  const details = useCallback(() => { void showPioraMessage({ title: copy("连接详情", "Connection details"), tone: "info",
    message: `${device ? formatHarmonyDeviceLabel(device) : serial}\n${copy("原生视频 · 独立解码", "Native video · dedicated decoder")}\n${live.frame ? `${live.frame.width} × ${live.frame.height}` : copy("尚无画面", "No frame")}\n${live.statistics ? `${copy("收流 / 解码 / 绘制", "Receive / decode / draw")}: ${live.statistics.receivedFps.toFixed(1)} / ${live.statistics.decodedFps.toFixed(1)} / ${live.statistics.presentedFps.toFixed(1)} FPS\n${copy("主机接收至绘制 P95", "Host receive-to-draw P95")}: ${live.statistics.receiveToDrawP95Ms.toFixed(1)} ms\n${copy("此时间不包含手机采集和传输，不代表端到端延迟。", "This excludes device capture and transport; it is not end-to-end latency.")}\n${copy("恢复次数", "Recoveries")}: ${live.statistics.reconnects}` : ""}\n${[input.error, live.error, deviceError].filter(Boolean).join("\n")}`,
    actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] }); }, [copy, device, serial, live, input.error, deviceError]);
  useEffect(() => window.piDesktop?.harmonyMirror?.onCommand(command => {
    if (command === "screenshot" && canScreenshot) void media.action("capture_screenshot");
    if (command === "record") record();
    if (command === "reconnect") live.refresh();
    if (command === "details") details();
  }), [media, record, live, details, canScreenshot]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const binding = bindings["harmony.screenshot"];
      if (!binding || !canScreenshot || event.repeat || event.isComposing || shouldPreserveApplicationShortcut(event.target)) return;
      if (shortcutMatchesEvent(event, binding, isMacPlatform(window.piDesktop?.platform))) { event.preventDefault(); void media.action("capture_screenshot"); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [bindings, canScreenshot, media]);
  const clock = `${String(Math.floor(media.elapsed / 60)).padStart(2, "0")}:${String(media.elapsed % 60).padStart(2, "0")}`;
  return <div ref={rootRef} className={`${styles.root} ${embedded ? styles.embedded : ""}`} data-dark={isDark}>
    <header className={styles.titlebar} data-dark={isDark}>
      <span className={styles.device} title={device ? formatHarmonyDeviceLabel(device) : serial}>{device ? formatHarmonyDeviceTitle(device, copy("鸿蒙设备", "Harmony device")) : copy("鸿蒙投屏", "Harmony mirror")}</span>
      {live.statistics ? <button className={styles.fps} title={copy("连接详情", "Connection details")} onClick={details}>{Math.round(live.statistics.presentedFps)}<small> FPS</small></button> : null}
      {media.recording ? <span className={styles.recording} title={copy(`录屏 ${clock} · 最长30分钟`, `Recording ${clock} · 30 minute limit`)}>●<span className={styles.clock}>{clock}</span></span> : null}
      <button className={styles.capture} disabled={!canScreenshot || Boolean(media.busy)} title={copy("截图", "Screenshot")} aria-label={copy("截图", "Screenshot")} onClick={() => { void media.action("capture_screenshot"); }}><AliIcon name="camera" size={16} /></button>
      <button className={styles.record} disabled={media.transitioning || device?.state !== "online" || Boolean(media.recording && !media.ownsRecording)} title={media.recording ? copy("停止并保存", "Stop and save") : copy("录屏 · 最长30分钟", "Record · 30 minute limit")} aria-label={media.recording ? copy("停止录屏", "Stop recording") : copy("开始录屏", "Start recording")} onClick={record}><AliIcon name={media.recording ? "stop" : "record-circle"} size={16} /></button>
      <button title={embedded ? copy("切换到悬浮投屏", "Float mirror") : copy("在侧栏显示", "Dock mirror")} aria-label={embedded ? copy("切换到悬浮投屏", "Float mirror") : copy("在侧栏显示", "Dock mirror")} onClick={() => { void window.piDesktop?.harmonyMirror?.setPresentation(embedded ? "floating" : "sidebar"); }}><AliIcon name="layout" size={14} /></button>
      <button aria-label={copy("操控手机", "Control device")} title={copy("操控手机", "Control device")} aria-pressed={controlEnabled} onClick={() => setControlEnabled(value => !value)}><AliIcon name="mouse-pointer" size={16} /></button>
      <button aria-label={copy("投屏菜单", "Mirror menu")} title={copy("投屏菜单", "Mirror menu")} onClick={() => { if (embedded) details(); else void window.piDesktop?.harmonyMirror?.showMenu(); }}><AliIcon name="ellipsis" size={16} /></button>
      <button aria-label={copy("关闭投屏", "Close mirror")} onClick={() => { void window.piDesktop?.harmonyMirror?.close(); }}><AliIcon name="close" size={14} /></button>
    </header>
    {state?.presentationFailed ? <div className={styles.compatibility} role="status">{copy("切换未完成，已保留原画面，请重试。", "The view could not be moved. Your original view is still active; please retry.")}</div> : null}
    {media.recording?.systemRecorderStateUnknown ? <div className={styles.compatibility} role="status">
      <span>{copy("系统录屏状态未知，请先在手机上停止。", "Recording status is unknown. Stop it on the phone first.")}</span>
      <button disabled={media.transitioning || !media.ownsRecording} onClick={() => { void media.action("retrieve_recording"); }}>{copy("我已停止，取回录屏", "Stopped on phone · retrieve")}</button>
    </div> : null}
    {media.recoveries.length ? <details className={styles.compatibility}>
      <summary>{copy(`${media.recoveries.length} 段录屏待保存`, `${media.recoveries.length} recordings await saving`)}</summary>
      {media.recoveries.map(draft => <div key={draft.recordingId}>
        <time>{new Date(draft.startedAt).toLocaleString()}</time>
        <button disabled={Boolean(media.busy)} onClick={() => { void media.action("retry_recording_save", draft.recordingId); }}>{copy("重试保存", "Retry save")}</button>
      </div>)}
    </details> : null}
    <main ref={screenRef} className={styles.screen} data-zoomed={zoom !== "fit"}>
      <div ref={live.surfaceRef} className={styles.surface} tabIndex={controlEnabled ? 0 : -1} aria-label={copy("投屏交互区域", "Mirror interaction area")} data-interactive={controlEnabled}
        style={zoom !== "fit" && width && height ? { width: width * Number(zoom), height: height * Number(zoom), flex: "none" } : undefined} {...input.handlers} />
      {!live.frame ? <div className={styles.placeholder} role="status">{device?.state !== "online" ? copy("等待设备连接", "Waiting for device") : live.state === "error" ? copy("连接已暂停", "Connection paused") : copy("正在连接画面…", "Connecting…")}</div> : null}
      {live.error || input.error || deviceError || live.frame && device?.state !== "online" ? <div className={styles.connectionNotice} role="status">
        <span title={input.error ?? live.error ?? deviceError}>{input.error ? input.error : device?.state !== "online" ? copy("设备已断开，保留最后画面", "Disconnected · last frame retained") : live.state === "recovering" ? copy("正在恢复连接", "Reconnecting") : copy("投屏连接已暂停", "Mirror paused")}</span>
        <button type="button" onClick={details}>{copy("详情", "Details")}</button>
        <button type="button" onClick={live.refresh}>{copy("重连", "Reconnect")}</button>
      </div> : null}
    </main>
    {controlEnabled ? <footer className={styles.controls} aria-label={copy("手机控制", "Device controls")}>
      <div className={styles.controlRow}>
        <div className={styles.controlGroup} role="group" aria-label={copy("手机导航", "Device navigation")}>
          {(["back", "home", "recents"] as const).map((key, index) => <button type="button" key={key} disabled={!input.canControl} title={copy(["返回", "主页", "最近任务"][index], key)} aria-label={copy(["返回", "主页", "最近任务"][index], key)} onClick={() => { void input.send({ action: "press_key", key }); }}><AliIcon name={(["arrowleft", "home", "copy"] as const)[index]} size={18} /></button>)}
        </div>
        <div className={styles.controlGroup} role="group" aria-label={copy("设备按键", "Device keys")}>
          {(["volume_down", "volume_up", "power"] as const).map((key, index) => <button type="button" key={key} disabled={!input.canControl} title={copy(["音量−", "音量＋", "电源键"][index], ["Volume −", "Volume +", "Power"][index])} aria-label={copy(["音量−", "音量＋", "电源键"][index], ["Volume −", "Volume +", "Power"][index])} onClick={() => { void input.send({ action: "press_key", key }); }}><AliIcon name={(["volume-minus", "volume-plus", "power"] as const)[index]} size={18} /></button>)}
        </div>
        <MirrorViewControls zoom={zoom} onZoom={setZoom} pinned={Boolean(state?.alwaysOnTop)} onPin={() => { void window.piDesktop?.harmonyMirror?.setAlwaysOnTop(!state?.alwaysOnTop); }} chinese={chinese} />
      </div>

    </footer> : null}
  </div>;
}
