"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHarmonyWindow } from "@/hooks/useHarmonyWindow";
import { useHarmonyLiveFrame } from "@/hooks/useHarmonyLiveFrame";
import { useHarmonyMedia, harmonyJson } from "@/hooks/useHarmonyMedia";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { isMacPlatform, shortcutMatchesEvent, shouldPreserveApplicationShortcut } from "@/lib/keyboard-shortcuts";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { showPioraMessage } from "@/components/PioraMessage";
import { AliIcon } from "@/components/AliIcon";
import type { MirrorScale } from "@/desktop/src/harmony-window-types";
import { formatHarmonyDeviceTitle, formatHarmonyDeviceLabel } from "@/lib/harmony/device-label";
import styles from "./MirrorWindow.module.css";

type Device = { serial: string; name?: string; model?: string; product?: string; state: string; generation: number; capabilities: Record<string, boolean> };
export function MirrorWindow({ embedded = false, serial: embeddedSerial, active = true, onEnableVideo }: { embedded?: boolean; serial?: string; active?: boolean; onEnableVideo?: () => void } = {}) {
  const { isDark } = useTheme();
  useFontPreferences();
  const { locale } = useI18n(); const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const state = useHarmonyWindow(); const serial = embedded ? embeddedSerial ?? "" : state?.serial ?? "";
  const [device, setDevice] = useState<Device | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const [enablingVideo, setEnablingVideo] = useState(false);
  const enabling = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { bindings } = useApplicationShortcuts();
  useEffect(() => {
    setDevice(null); if (!serial) return;
    const controller = new AbortController(); let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try { const data = await harmonyJson<{ devices: Device[] }>("/api/harmony/devices", undefined, controller.signal);
        if (!controller.signal.aborted) { setDevice(data.devices.find(item => item.serial === serial) ?? null); setDeviceError(""); }
      } catch (error) { if (!controller.signal.aborted) setDeviceError(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => { void load(); }, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [serial]);
  const live = useHarmonyLiveFrame({ active: active && Boolean(state?.open && (embedded ? state.presentation === "sidebar" : state.presentation !== "sidebar" && !state.minimized)), enabled: device?.state === "online", serial, calibrateGeometry: false,
    generation: device?.generation, canvasRef, chinese, fallbackError: copy("画面连接失败", "Could not connect to the device") });
  const media = useHarmonyMedia(serial, state?.ownerId ?? "", Boolean(serial), chinese);
  const enableVideo = async () => {
    if (enabling.current || !serial) return;
    if (onEnableVideo) { onEnableVideo(); return; }
    enabling.current = true; setEnablingVideo(true);
    let token: string | undefined;
    try {
      const { lease } = await harmonyJson<{ lease: { token: string } }>("/api/harmony/manual", { action: "acquire", serial, ownerId: `manual:mirror-init:${crypto.randomUUID()}` });
      token = lease.token;
      await harmonyJson("/api/harmony/action", { action: "initialize_mirror", serial, leaseToken: token });
      await showPioraMessage({ title: copy("在手机上确认屏幕共享", "Confirm screen sharing on the phone"), message: copy("请在手机上的 Piora 投屏页面开始共享并允许授权，然后点击“重新连接”。", "Start screen sharing in the Piora phone component and allow capture, then reconnect."), actions: [{ id: "connect", label: copy("重新连接", "Reconnect"), primary: true }] });
      live.refresh();
    } catch (error) {
      await showPioraMessage({ title: copy("实时视频未建立", "Live video could not start"), message: error instanceof Error ? error.message : String(error), tone: "error", actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] });
    } finally {
      if (token) await harmonyJson("/api/harmony/manual", { action: "release", leaseToken: token }).catch(() => undefined);
      enabling.current = false; setEnablingVideo(false);
    }
  };
  const canScreenshot = device?.state === "online" && device.capabilities?.screenshot;
  const width = live.frame?.width, height = live.frame?.height;
  useEffect(() => {
    if (!embedded && width && height) void window.piDesktop?.harmonyMirror?.reportFrame({ serial, width, height });
  }, [serial, width, height, embedded]);
  const record = useCallback(() => {
    if (media.recording && !media.ownsRecording) return;
    void media.action(media.recording?.systemRecorderStateUnknown ? "retrieve_recording" : media.recording ? "stop_recording" : "start_recording");
  }, [media]);
  const details = useCallback(() => { void showPioraMessage({ title: copy("连接详情", "Connection details"), tone: "info",
    message: `${device ? formatHarmonyDeviceLabel(device) : serial}\n${live.mode === "video" ? copy("原生视频流", "Native video") : copy("截图兼容模式", "Screenshot fallback")}\n${live.frame ? `${live.frame.width} × ${live.frame.height}` : copy("尚无画面", "No frame")}\n${live.metrics ? `${live.metrics.fps} FPS · ${copy("主机绘制", "Host draw")} ${live.metrics.drawMs} ms\n${copy("绘制耗时不代表端到端延迟。", "Draw time is not end-to-end latency.")}` : ""}\n${live.fallbackReason ?? live.error ?? ""}`,
    actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] }); }, [copy, device, serial, live]);
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
  return <div className={`${styles.root} ${embedded ? styles.embedded : ""}`}>
    <header className={styles.titlebar} data-dark={isDark}>
      <span className={styles.device} title={device ? formatHarmonyDeviceLabel(device) : serial}>{device ? formatHarmonyDeviceTitle(device, copy("鸿蒙设备", "Harmony device")) : copy("鸿蒙投屏", "Harmony mirror")}</span>
      {media.recording ? <span className={styles.recording} title={copy(`录屏 ${clock} · 最长30分钟`, `Recording ${clock} · 30 minute limit`)}>●<span className={styles.clock}>{clock}</span></span> : null}
      <select className={styles.scale} aria-label={copy("画面缩放", "Screen zoom")} value={state?.scale ?? 75} onChange={event => { void window.piDesktop?.harmonyMirror?.setScale(Number(event.target.value) as MirrorScale); }}>{[25, 50, 75, 100].map(value => <option key={value} value={value}>{value}%</option>)}</select>
      <button className={styles.capture} disabled={!canScreenshot || Boolean(media.busy)} title={copy("截图", "Screenshot")} aria-label={copy("截图", "Screenshot")} onClick={() => { void media.action("capture_screenshot"); }}><AliIcon name="save" size={15} /></button>
      <button className={styles.record} disabled={media.transitioning || device?.state !== "online" || Boolean(media.recording && !media.ownsRecording)} title={media.recording ? copy("停止并保存", "Stop and save") : copy("录屏 · 最长30分钟", "Record · 30 minute limit")} aria-label={media.recording ? copy("停止录屏", "Stop recording") : copy("开始录屏", "Start recording")} onClick={record}><AliIcon name={media.recording ? "stop" : "play"} size={15} /></button>
      <button title={embedded ? copy("切换到悬浮投屏", "Float mirror") : copy("在侧栏显示", "Dock mirror")} aria-label={embedded ? copy("切换到悬浮投屏", "Float mirror") : copy("在侧栏显示", "Dock mirror")} onClick={() => { void window.piDesktop?.harmonyMirror?.setPresentation(embedded ? "floating" : "sidebar"); }}><AliIcon name="layout" size={14} /></button>
      <button aria-label={copy("投屏菜单", "Mirror menu")} onClick={() => { if (embedded) details(); else void window.piDesktop?.harmonyMirror?.showMenu(); }}>⋯</button>
      <button aria-label={copy("关闭投屏", "Close mirror")} onClick={() => { void window.piDesktop?.harmonyMirror?.close(); }}><AliIcon name="close" size={14} /></button>
    </header>
    {live.mode === "frames" ? <div className={styles.compatibility} role="status" title={live.fallbackReason ?? live.error ?? ""}><span>{copy("兼容截图", "Screenshot fallback")}{live.metrics ? ` · ${live.metrics.fps} FPS` : ""}</span><button disabled={enablingVideo} onClick={() => { void enableVideo(); }}>{enablingVideo ? copy("正在启用…", "Enabling…") : copy("启用实时投屏", "Enable live video")}</button></div> : null}
    <main className={styles.screen}><canvas ref={canvasRef} role="img" aria-label={copy("手机画面", "Device screen")} />
      {device?.state !== "online" || live.status !== "live" ? <div className={styles.placeholder} role="status">{deviceError || (device?.state !== "online" ? copy("等待设备连接", "Waiting for device") : live.status === "error" ? copy("正在重新连接…", "Reconnecting…") : copy("正在连接画面…", "Connecting…"))}</div> : null}
    </main>
  </div>;
}
