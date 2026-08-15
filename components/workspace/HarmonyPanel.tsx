"use client";

/* Device frames are live, no-store screenshots; Next Image caching is intentionally not applicable. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useHarmonyLiveFrame } from "@/hooks/useHarmonyLiveFrame";
import { AliIcon } from "../AliIcon";
import styles from "./HarmonyPanel.module.css";

type RuntimeProfile = "normal" | "device-control";
type HarmonyDevice = {
  serial: string;
  state: "online" | "unauthorized" | "offline" | "unknown";
  name?: string;
  model?: string;
  osVersion?: string;
  generation: number;
  capabilities: Record<string, boolean>;
};
type PublicLease = { serial: string; owner: { kind: "agent" | "manual"; id: string; sessionId?: string }; expiresAt: string };
type HarmonyState = {
  runtime: { status: string; hdcPath?: string; error?: { code?: string; message?: string } };
  devices: HarmonyDevice[];
  leases: PublicLease[];
  snapshots: Array<{ serial: string; generation: number; revision: number; capturedAt: string; hasTree: boolean; hasScreenshot: boolean }>;
};
type ManualLease = { token: string; serial: string; expiresAt: string };
type RuntimeCandidate = { hdcPath: string; sdkPath: string; source: "selection" | "environment" | "config" | "deveco" | "path" };
type VisionModel = { provider: string; modelId: string; name: string };
type HarmonyConfig = {
  hdcPath?: string;
  vision?: { enabled: boolean; provider: string; modelId: string; shareScreenshotWithActionModel?: boolean };
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string } & T;
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return payload;
}

export function HarmonyPanel({ active }: { active: boolean }) {
  const { locale } = useI18n();
  const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const [profile, setProfile] = useState<RuntimeProfile | "web">("web");
  const [devices, setDevices] = useState<HarmonyDevice[]>([]);
  const [managerState, setManagerState] = useState<HarmonyState | null>(null);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [lease, setLease] = useState<ManualLease | null>(null);
  const [sdkPath, setSdkPath] = useState("");
  const [runtimeCandidates, setRuntimeCandidates] = useState<RuntimeCandidate[]>([]);
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModelKey, setVisionModelKey] = useState("");
  const [shareScreenshot, setShareScreenshot] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [tree, setTree] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [bundleName, setBundleName] = useState("");
  const [abilityName, setAbilityName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameInteractionError, setFrameInteractionError] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const ownerIdRef = useRef("");
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLImageElement>(null);
  const leaseRef = useRef<ManualLease | null>(null);

  useEffect(() => {
    const ownerKey = "piora-harmony-manual-owner-v1";
    let existingOwner: string | null = null;
    try { existingOwner = window.sessionStorage.getItem(ownerKey); } catch { /* Storage may be unavailable in hardened webviews. */ }
    ownerIdRef.current = existingOwner && /^manual:[A-Za-z0-9-]{1,80}$/.test(existingOwner)
      ? existingOwner
      : `manual:${crypto.randomUUID()}`;
    try { window.sessionStorage.setItem(ownerKey, ownerIdRef.current); } catch { /* The in-memory identity still works. */ }
    void jsonRequest<{ profile: RuntimeProfile }>("/api/harmony/profile")
      .then((result) => setProfile(result.profile))
      .catch(() => setProfile(window.piDesktop ? "normal" : "web"));
  }, []);

  const selected = useMemo(
    () => devices.find((device) => device.serial === selectedSerial) ?? null,
    [devices, selectedSerial],
  );
  const selectedOnline = selected?.state === "online";
  const desktopAvailable = profile !== "web";
  const selectedGeneration = selected?.generation;
  const canScreenshot = Boolean(selectedOnline && selected?.capabilities.screenshot);
  const {
    frame: liveFrame,
    status: frameStatus,
    error: frameLoadError,
    refresh: requestFrame,
  } = useHarmonyLiveFrame({
    active: active && desktopAvailable,
    enabled: canScreenshot,
    serial: selectedSerial,
    generation: selectedGeneration,
    fallbackError: copy("投屏暂不可用，请检查设备授权与 HDC。", "Live view unavailable. Check device authorization and HDC."),
  });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!desktopAvailable) return;
    try {
      const devicePayload = await jsonRequest<{ devices: HarmonyDevice[]; state: HarmonyState }>("/api/harmony/devices", { signal });
      setDevices(devicePayload.devices);
      setManagerState(devicePayload.state);
      setSelectedSerial((current) => current && devicePayload.devices.some((device) => device.serial === current)
        ? current
        : devicePayload.devices.find((device) => device.state === "online")?.serial ?? devicePayload.devices[0]?.serial ?? "");
      setError(null);
    } catch (refreshError) {
      if (signal?.aborted) return;
      setError(messageOf(refreshError, copy("无法读取设备状态", "Unable to read device state")));
    }
  }, [copy, desktopAvailable]);

  const loadConfig = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const [payload, modelPayload] = await Promise.all([
        jsonRequest<{ config: HarmonyConfig; diagnostics: HarmonyState & { runtime?: { hdcPath?: string } }; candidates: RuntimeCandidate[] }>("/api/harmony/config"),
        jsonRequest<{ models: VisionModel[]; error?: string }>("/api/harmony/vision-models"),
      ]);
      const candidates = payload.candidates ?? [];
      setRuntimeCandidates(candidates);
      setSdkPath(payload.config.hdcPath ?? payload.diagnostics?.runtime?.hdcPath ?? candidates[0]?.hdcPath ?? "");
      setVisionModels(modelPayload.models ?? []);
      const vision = payload.config.vision;
      setVisionEnabled(Boolean(vision?.enabled));
      setVisionModelKey(vision ? `${vision.provider}\u0000${vision.modelId}` : "");
      setShareScreenshot(Boolean(vision?.shareScreenshotWithActionModel));
      setDiagnostics(payload.diagnostics);
    } catch (configError) {
      setError(messageOf(configError, copy("无法读取 SDK 配置", "Unable to read SDK configuration")));
    }
  }, [copy, desktopAvailable]);

  useEffect(() => {
    if (!active || !desktopAvailable) return;
    void loadConfig();
    let pollTimer: number | undefined;
    let pollController: AbortController | undefined;
    let disposed = false;
    const poll = async () => {
      pollController = new AbortController();
      await refresh(pollController.signal).catch(() => undefined);
      pollController = undefined;
      if (!disposed) pollTimer = window.setTimeout(() => { void poll(); }, 5_000);
    };
    void poll();
    const source = new EventSource("/api/harmony/events");
    source.onmessage = (event) => {
      try {
        const metadata = JSON.parse(event.data) as {
          type?: string;
          serial?: string;
          devices?: HarmonyDevice[];
          state?: HarmonyState;
        };
        if (metadata.type === "devices" && Array.isArray(metadata.devices)) {
          setDevices(metadata.devices);
          setSelectedSerial((current) => current && metadata.devices?.some((device) => device.serial === current)
            ? current
            : metadata.devices?.find((device) => device.state === "online")?.serial ?? metadata.devices?.[0]?.serial ?? "");
        } else if (metadata.type === "state" && metadata.state) {
          setManagerState(metadata.state);
        } else if (metadata.type !== "connected" && metadata.type !== "heartbeat" && metadata.type !== "snapshot") {
          void jsonRequest<{ state: HarmonyState }>(`/api/harmony/state${selectedSerial ? `?serial=${encodeURIComponent(selectedSerial)}` : ""}`)
            .then((payload) => setManagerState(payload.state))
            .catch(() => undefined);
        }
      } catch {
        // A malformed metadata event cannot affect the device command path.
      }
    };
    source.onerror = () => { /* Polling below remains the recovery path. */ };
    return () => {
      disposed = true;
      source.close();
      pollController?.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [active, desktopAvailable, loadConfig, refresh, selectedSerial]);

  useEffect(() => {
    if (!lease) return;
    const timer = window.setInterval(() => {
      void jsonRequest<{ lease: ManualLease }>("/api/harmony/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "renew", leaseToken: lease.token }),
      }).then((payload) => setLease(payload.lease)).catch(() => setLease(null));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [lease]);

  useEffect(() => {
    leaseRef.current = lease;
  }, [lease]);

  useEffect(() => {
    const releaseCurrentLease = () => {
      const current = leaseRef.current;
      if (!current) return;
      leaseRef.current = null;
      void fetch("/api/harmony/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", leaseToken: current.token }),
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", releaseCurrentLease);
    return () => {
      window.removeEventListener("pagehide", releaseCurrentLease);
      releaseCurrentLease();
    };
  }, []);

  useEffect(() => {
    if (active || !lease) return;
    const token = lease.token;
    setLease(null);
    void jsonRequest("/api/harmony/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseToken: token }),
      keepalive: true,
    }).catch(() => undefined);
  }, [active, lease]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, after?: (value: T) => void) => {
    setBusy(true);
    try {
      const value = await operation();
      after?.(value);
      setError(null);
      return value;
    } catch (operationError) {
      setError(messageOf(operationError, copy("设备操作失败", "Device operation failed")));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [copy]);

  const chooseRuntimePath = useCallback(async (kind: "sdk" | "hdc") => {
    const selectedPath = await window.piDesktop?.selectHarmonyRuntimePath?.(kind);
    if (!selectedPath) return;
    await run(async () => {
      const payload = await jsonRequest<{ candidates: RuntimeCandidate[] }>("/api/harmony/runtime-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectionPath: selectedPath }),
      });
      const selected = payload.candidates.find((candidate) => candidate.source === "selection");
      if (!selected) throw new Error(copy("所选位置中没有找到 hdc", "No hdc executable was found in the selected location"));
      setRuntimeCandidates(payload.candidates);
      setSdkPath(selected.hdcPath);
    });
  }, [copy, run]);

  const acquire = () => selectedSerial && void run(
    () => jsonRequest<{ lease: ManualLease }>("/api/harmony/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acquire", serial: selectedSerial, ownerId: ownerIdRef.current }),
    }),
    (payload) => setLease(payload.lease),
  );

  const release = () => lease && void run(
    () => jsonRequest("/api/harmony/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseToken: lease.token }),
    }),
    () => setLease(null),
  );

  const action = (input: Record<string, unknown>) => {
    if (!selectedSerial || !lease) return Promise.resolve(undefined);
    return run(() => jsonRequest("/api/harmony/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: selectedSerial, leaseToken: lease.token, ...input }),
    }), () => {
      requestFrame();
      void refresh();
    });
  };

  const saveSettings = () => void run(async () => {
    const [provider, modelId] = visionModelKey.split("\u0000");
    const payload = await jsonRequest<{ config: HarmonyConfig; diagnostics: unknown; candidates: RuntimeCandidate[] }>("/api/harmony/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hdcPath: sdkPath.trim() || null,
        vision: visionEnabled ? { enabled: true, provider, modelId, shareScreenshotWithActionModel: shareScreenshot } : null,
      }),
    });
    setSdkPath(payload.config.hdcPath ?? payload.candidates[0]?.hdcPath ?? "");
    setRuntimeCandidates(payload.candidates);
    setDiagnostics(payload.diagnostics);
    await refresh();
    return payload;
  }, () => setSettingsOpen(false));

  const imagePoint = (event: React.PointerEvent<HTMLImageElement>) => {
    const image = frameRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return null;
    const bounds = image.getBoundingClientRect();
    const x = Math.round(((event.clientX - bounds.left) / bounds.width) * image.naturalWidth);
    const y = Math.round(((event.clientY - bounds.top) / bounds.height) * image.naturalHeight);
    if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return null;
    return { x, y };
  };

  if (profile === "web") {
    return <div className={styles.gate}>
      <AliIcon name="mobile" size={34} />
      <h2>{copy("鸿蒙设备控制", "Harmony device control")}</h2>
      <p>{copy("该能力仅在 Piora 桌面应用中提供。", "This capability is available only in the Piora desktop app.")}</p>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
    </div>;
  }

  const snapshot = managerState?.snapshots.find((item) => item.serial === selectedSerial);
  const holder = managerState?.leases.find((item) => item.serial === selectedSerial);
  const frameMatchesDevice = Boolean(liveFrame && selected && liveFrame.serial === selected.serial && liveFrame.generation === selected.generation);
  const frameUrl = active && canScreenshot && frameMatchesDevice ? liveFrame?.url ?? "" : "";
  const frameError = frameInteractionError ?? frameLoadError;
  const ownsRecoverableLease = Boolean(holder?.owner.kind === "manual" && holder.owner.id === ownerIdRef.current);
  const canPointControl = Boolean(lease?.serial === selectedSerial && frameStatus === "live" && frameMatchesDevice && selected?.capabilities.tap);
  const runtimeReady = managerState?.runtime.status === "ready";
  const deviceStateLabel = selected?.state === "online"
    ? copy("已连接", "Connected")
    : selected?.state === "unauthorized"
      ? copy("等待手机授权", "Authorization needed")
      : selected
        ? copy("设备离线", "Offline")
        : copy("未连接", "Not connected");
  const visionModel = visionModels.find((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey);

  return <div className={styles.root}>
    <header className={styles.toolbar}>
      <div className={styles.toolbarTitle}>
        <span className={styles.deviceMark}><AliIcon name="mobile" size={15} /></span>
        <span><strong>{copy("鸿蒙设备", "Harmony device")}</strong><small data-state={runtimeReady ? "ready" : "idle"}>{runtimeReady ? copy("服务已就绪", "Ready") : copy("需要设置", "Setup needed")}</small></span>
      </div>
      <div className={styles.toolbarActions}>
        <button className={styles.iconButton} type="button" onClick={() => { requestFrame(); void refresh(); }} disabled={busy} title={copy("刷新设备", "Refresh devices")} aria-label={copy("刷新设备", "Refresh devices")}><AliIcon name="reload" size={14} /></button>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen((open) => !open)} aria-pressed={settingsOpen} title={copy("设备设置", "Device settings")} aria-label={copy("设备设置", "Device settings")}><AliIcon name="setting" size={15} /></button>
      </div>
    </header>

    {settingsOpen ? <section className={styles.settingsPanel} aria-label={copy("设备设置", "Device settings")}>
      <div className={styles.settingsHeading}>
        <span><strong>{copy("设备设置", "Device settings")}</strong><small>{copy("通常只需设置一次", "Usually a one-time setup")}</small></span>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen(false)} aria-label={copy("关闭设置", "Close settings")}><AliIcon name="close" size={13} /></button>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingCopy}><strong>{copy("连接工具", "Connection")}</strong><small>{copy("选择 DevEco 中的 HDC", "Choose HDC from DevEco")}</small></div>
        {runtimeCandidates.length > 1 ? <select aria-label={copy("检测到的 HDC", "Detected HDC installations")} value={sdkPath} onChange={(event) => setSdkPath(event.target.value)}>
          {sdkPath && !runtimeCandidates.some((candidate) => candidate.hdcPath === sdkPath) ? <option value={sdkPath}>{sdkPath}</option> : null}
          {runtimeCandidates.map((candidate) => <option key={candidate.hdcPath} value={candidate.hdcPath}>{candidate.hdcPath}</option>)}
        </select> : null}
        <div className={styles.pathRow}>
          <input aria-label={copy("HDC 路径", "HDC path")} value={sdkPath} placeholder={copy("选择 DevEco SDK 或 hdc.exe", "Choose DevEco SDK or hdc.exe")} onChange={(event) => setSdkPath(event.target.value)} />
          <button className={styles.iconButton} type="button" disabled={busy} onClick={() => void chooseRuntimePath("sdk")} title={copy("选择 SDK 文件夹", "Choose SDK folder")} aria-label={copy("选择 SDK 文件夹", "Choose SDK folder")}><AliIcon name="folder-open" size={14} /></button>
          <button className={styles.iconButton} type="button" disabled={busy} onClick={() => void chooseRuntimePath("hdc")} title={copy("选择 hdc.exe", "Choose hdc.exe")} aria-label={copy("选择 hdc.exe", "Choose hdc.exe")}><AliIcon name="file" size={14} /></button>
        </div>
        {!runtimeCandidates.length ? <p className={styles.inlineHint}>{copy("没有自动找到，请手动选择。", "Nothing detected. Choose it manually.")}</p> : null}
      </div>

      <div className={styles.settingGroup}>
        <label className={styles.settingToggle}>
          <span className={styles.settingCopy}><strong>{copy("视觉模型", "Vision model")}</strong><small>{copy("只负责看手机屏幕", "Only reads the phone screen")}</small></span>
          <input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />
        </label>
        {visionEnabled ? <>
          <select aria-label={copy("选择视觉模型", "Select vision model")} value={visionModelKey} onChange={(event) => setVisionModelKey(event.target.value)}>
            <option value="">{copy("选择模型", "Choose model")}</option>
            {visionModelKey && !visionModels.some((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey)
              ? <option value={visionModelKey}>{copy("当前不可用", "Currently unavailable")} · {visionModelKey.replace("\u0000", "/")}</option>
              : null}
            {visionModels.map((model) => <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>{model.name} · {model.provider}</option>)}
          </select>
          <p className={styles.modelFlow}>{copy(`视觉模型看屏幕${visionModel ? `（${visionModel.name}）` : ""}，当前对话模型负责操作。`, `The vision model reads the screen${visionModel ? ` (${visionModel.name})` : ""}; the current chat model takes action.`)}</p>
          <label className={styles.compactCheck}><input type="checkbox" checked={shareScreenshot} onChange={(event) => setShareScreenshot(event.target.checked)} />{copy("也让对话模型查看原图", "Let the chat model see the raw image too")}</label>
        </> : null}
      </div>

      <div className={styles.settingsFooter}>
        <button type="button" onClick={() => setSettingsOpen(false)}>{copy("取消", "Cancel")}</button>
        <button className={styles.primaryButton} type="button" disabled={busy || (visionEnabled && !visionModelKey)} onClick={saveSettings}>{copy("保存", "Save")}</button>
      </div>
    </section> : null}

    <main className={styles.content}>
    <div className={styles.deviceBar}>
      <select aria-label={copy("选择设备", "Select device")} value={selectedSerial} onChange={(event) => {
        const nextSerial = event.target.value;
        if (lease) {
          const token = lease.token;
          setLease(null);
          void jsonRequest("/api/harmony/manual", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "release", leaseToken: token }),
          }).catch(() => undefined);
        }
        setSelectedSerial(nextSerial);
        setTree(null);
        setFrameSize(null);
      }}>
        {!devices.length ? <option value="">{copy("没有设备", "No device")}</option> : null}
        {devices.map((device) => <option key={device.serial} value={device.serial}>{device.name || device.model || device.serial}</option>)}
      </select>
      <span className={styles.deviceState} data-state={selected?.state ?? "unknown"}><i />{deviceStateLabel}</span>
      {lease?.serial === selectedSerial
        ? <button className={styles.controlButton} type="button" onClick={release}>{copy("结束控制", "Release")}</button>
        : <button className={styles.controlButton} type="button" disabled={!selected || selected.state !== "online" || (Boolean(holder) && !ownsRecoverableLease)} onClick={acquire}>
          {ownsRecoverableLease ? copy("继续控制", "Resume") : copy("控制设备", "Control")}
        </button>}
      <button className={`${styles.iconButton} ${styles.stopButton}`} type="button" onClick={() => void run(
        () => jsonRequest("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "emergency_stop", reason: "desktop-panel" }) }),
        () => { setLease(null); void refresh(); },
      )} title={copy("停止所有设备操作", "Stop all device actions")} aria-label={copy("停止所有设备操作", "Stop all device actions")}><AliIcon name="stop" size={13} /></button>
    </div>
    {holder ? <div className={styles.controlNotice}><AliIcon name={holder.owner.kind === "agent" ? "robot" : "mobile"} size={13} />{holder.owner.kind === "agent" ? copy("AI 正在控制这台设备", "AI is controlling this device") : copy("你正在控制这台设备", "You are controlling this device")}</div> : null}

    <div className={styles.deviceArea}>
      <div className={styles.frame} data-enabled={canPointControl ? "true" : "false"}>
        {canScreenshot ? <div className={styles.frameStatus} data-status={frameStatus} aria-live="polite">
          <span />{frameStatus === "error" ? copy("投屏重连中", "Reconnecting") : frameStatus === "loading" ? copy("投屏更新中", "Updating") : copy("实时投屏", "Live view")}
          {frameSize ? ` · ${frameSize.width}×${frameSize.height}` : ""}
        </div> : null}
        {frameUrl ? <img
          ref={frameRef}
          src={frameUrl}
          alt={copy("手机实时截图", "Live device screenshot")}
          draggable={false}
          onLoad={() => {
            const image = frameRef.current;
            setFrameSize(image ? { width: image.naturalWidth, height: image.naturalHeight } : null);
            setFrameInteractionError(null);
          }}
          onError={() => {
            setFrameInteractionError(copy("投屏图片无法解码，正在重试。", "The live-view image could not be decoded; retrying."));
          }}
          onPointerDown={(event) => {
            if (!canPointControl) return;
            pointerStartRef.current = imagePoint(event);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            const from = pointerStartRef.current;
            const to = imagePoint(event);
            pointerStartRef.current = null;
            if (!from || !to || !lease || !liveFrame || !frameMatchesDevice) return;
            const distance = Math.hypot(to.x - from.x, to.y - from.y);
            if (distance > 12 && !selected?.capabilities.swipe) {
              setFrameInteractionError(copy("当前设备不支持滑动注入。", "This device does not support swipe injection."));
              return;
            }
            void action(distance > 12
              ? { action: "swipe", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: 300, generation: liveFrame.generation }
              : { action: "tap", x: to.x, y: to.y, generation: liveFrame.generation });
          }}
        /> : <div className={styles.frameEmpty}>
          <AliIcon name="mobile" size={28} />
          <strong>{selectedOnline && !selected?.capabilities.screenshot ? copy("无法显示屏幕", "Screen unavailable") : copy("连接一台设备", "Connect a device")}</strong>
          <span>{selectedOnline && !selected?.capabilities.screenshot ? copy("当前设备不支持截图", "Screen capture is not supported") : copy("画面会显示在这里", "Its screen will appear here")}</span>
          {!runtimeReady ? <button type="button" onClick={() => setSettingsOpen(true)}>{copy("打开设置", "Open settings")}</button> : null}
        </div>}
      </div>
    </div>

    <div className={styles.quickControls}>
      <div className={styles.keyRow} aria-label={copy("系统按键", "System keys")}>
        <button type="button" disabled={!lease || busy || !selected?.capabilities.keys} onClick={() => void action({ action: "press_key", key: "back" })} title={copy("返回", "Back")}><AliIcon name="arrowleft" size={14} /><span>{copy("返回", "Back")}</span></button>
        <button type="button" disabled={!lease || busy || !selected?.capabilities.keys} onClick={() => void action({ action: "press_key", key: "home" })} title={copy("主页", "Home")}><AliIcon name="home" size={14} /><span>{copy("主页", "Home")}</span></button>
        <button type="button" disabled={!lease || busy || !selected?.capabilities.keys} onClick={() => void action({ action: "press_key", key: "recents" })} title={copy("最近任务", "Recents")}><AliIcon name="layout" size={14} /><span>{copy("最近", "Recent")}</span></button>
      </div>
      <form className={styles.textControl} onSubmit={(event) => { event.preventDefault(); if (text) void action({ action: "input_text", text }).then((result) => { if (result !== undefined) setText(""); }); }}>
        <input aria-label={copy("输入到手机", "Type on device")} placeholder={copy("输入文字", "Type text")} value={text} onChange={(event) => setText(event.target.value)} />
        <button className={styles.iconButton} type="submit" disabled={!lease || !text || busy || !selected?.capabilities.inputText} title={copy("发送到手机", "Send to device")} aria-label={copy("发送到手机", "Send to device")}><AliIcon name="enter" size={14} /></button>
      </form>
    </div>

    <details className={styles.moreActions}>
      <summary>{copy("更多操作", "More actions")}</summary>
      <div className={styles.moreBody}>
        <form className={styles.launchForm} onSubmit={(event) => { event.preventDefault(); if (bundleName) void action({ action: "launch_app", bundleName, abilityName: abilityName || undefined }); }}>
          <div className={styles.sectionLabel}><strong>{copy("打开应用", "Open app")}</strong><small>{copy("输入应用标识", "Enter the app identifier")}</small></div>
          <input aria-label="Bundle" value={bundleName} onChange={(event) => setBundleName(event.target.value)} placeholder="com.example.app" />
          <input aria-label="Ability" value={abilityName} onChange={(event) => setAbilityName(event.target.value)} placeholder={copy("Ability（可选）", "Ability (optional)")} />
          <button type="submit" disabled={!lease || !bundleName || busy || !selected?.capabilities.launchApp}>{copy("打开", "Open")}</button>
        </form>
        <div className={styles.inspectRow}>
          <button type="button" disabled={!canScreenshot || busy} onClick={requestFrame}><AliIcon name="reload" size={13} />{copy("刷新画面", "Refresh screen")}</button>
          <button type="button" disabled={!selectedOnline || busy || !selected?.capabilities.uiTree} onClick={() => void run(
            () => jsonRequest<{ snapshot: unknown }>(`/api/harmony/tree?serial=${encodeURIComponent(selectedSerial)}`),
            (payload) => setTree(payload.snapshot),
          )}><AliIcon name="code" size={13} />{copy("读取界面结构", "Read interface structure")}</button>
        </div>
        <details className={styles.diagnostics}>
          <summary>{copy("开发者信息", "Developer details")}</summary>
          <pre>{JSON.stringify({ selected, holder, snapshot, diagnostics, tree }, null, 2)}</pre>
        </details>
      </div>
    </details>

    {frameError ? <div className={styles.frameError} role="status">{frameError}</div> : null}
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <p className={styles.safetyNote}><AliIcon name="lock" size={12} />{copy("AI 控制前会先征求你的同意", "AI asks before taking control")}</p>
    </main>
  </div>;
}
