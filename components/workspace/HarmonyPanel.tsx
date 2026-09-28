"use client";

import { brandText } from "@/lib/branding";

import { Component, useCallback, useEffect, useId, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useHarmonyManualControl } from "@/hooks/useHarmonyManualControl";
import { useHarmonyLiveFrame } from "@/hooks/useHarmonyLiveFrame";
import { formatHarmonyDeviceLabel } from "@/lib/harmony/device-label";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { framePointFromClient } from "@/lib/harmony/observation/geometry";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "../AliIcon";
import { HarmonyLogViewer } from "./HarmonyLogViewer";
import { HarmonyCheckPanel } from "./HarmonyCheckPanel";
import { WorkbenchTools } from "./harmony/WorkbenchTools";
import styles from "./HarmonyPanel.module.css";

type RuntimeProfile = "normal" | "device-control";
type HarmonyDevice = {
  serial: string;
  state: "online" | "unauthorized" | "offline" | "unknown";
  name?: string;
  model?: string;
  product?: string;
  osVersion?: string;
  generation: number;
  capabilities: Record<string, boolean>;
};
type PublicLease = { serial: string; owner: { kind: "agent" | "manual"; id: string; sessionId?: string }; expiresAt: string };
type HarmonyState = {
  runtime: { status: string; hdcPath?: string; error?: { code?: string; message?: string } };
  devices: HarmonyDevice[];
  leases: PublicLease[];
  controls: Array<{ serial: string; status: "stopping" | "recovering" }>;
  snapshots: Array<{ serial: string; generation: number; revision: number; capturedAt: string; hasTree: boolean; hasScreenshot: boolean }>;
};
type RecordingState = { serial: string; recordingId: string; startedAt: string; ownerId: string };
type MediaArtifact = { kind: "screenshot" | "recording"; path: string; filename: string; size: number };
type MediaNotice = {
  message: string;
  artifact?: MediaArtifact;
  copyStatus?: "copying" | "copied" | "failed";
  pathStatus?: "copying" | "copied" | "failed";
};
type RuntimeCandidate = { hdcPath: string; sdkPath: string; source: "selection" | "environment" | "config" | "deveco" | "path" | "bundled" };
type VisionModel = { provider: string; modelId: string; name: string };
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDevices(value: unknown): HarmonyDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const serial = optionalString(source?.serial);
    if (!source || !serial) return [];
    const rawState = source.state;
    const state: HarmonyDevice["state"] = rawState === "online" || rawState === "unauthorized" || rawState === "offline"
      ? rawState
      : "unknown";
    const rawCapabilities = recordOf(source.capabilities);
    const capabilities = Object.fromEntries(
      Object.entries(rawCapabilities ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
    return [{
      serial,
      state,
      ...(optionalString(source.name) ? { name: optionalString(source.name) } : {}),
      ...(optionalString(source.model) ? { model: optionalString(source.model) } : {}),
      ...(optionalString(source.product) ? { product: optionalString(source.product) } : {}),
      ...(optionalString(source.osVersion) ? { osVersion: optionalString(source.osVersion) } : {}),
      generation: typeof source.generation === "number" && Number.isFinite(source.generation) ? source.generation : 0,
      capabilities,
    }];
  });
}

function normalizeHarmonyState(value: unknown, fallbackDevices: HarmonyDevice[] = []): HarmonyState {
  const source = recordOf(value);
  const runtimeSource = recordOf(source?.runtime);
  const errorSource = recordOf(runtimeSource?.error);
  const leases = Array.isArray(source?.leases) ? source.leases.flatMap((item) => {
    const lease = recordOf(item);
    const owner = recordOf(lease?.owner);
    const serial = optionalString(lease?.serial);
    const ownerId = optionalString(owner?.id);
    const expiresAt = optionalString(lease?.expiresAt);
    if (!lease || !owner || !serial || !ownerId || !expiresAt) return [];
    const kind: PublicLease["owner"]["kind"] | null = owner.kind === "agent" ? "agent" : owner.kind === "manual" ? "manual" : null;
    if (!kind) return [];
    return [{ serial, expiresAt, owner: { kind, id: ownerId, ...(optionalString(owner.sessionId) ? { sessionId: optionalString(owner.sessionId) } : {}) } }];
  }) : [];
  const snapshots = Array.isArray(source?.snapshots) ? source.snapshots.flatMap((item) => {
    const snapshot = recordOf(item);
    const serial = optionalString(snapshot?.serial);
    const capturedAt = optionalString(snapshot?.capturedAt);
    if (!snapshot || !serial || !capturedAt) return [];
    return [{
      serial,
      generation: typeof snapshot.generation === "number" ? snapshot.generation : 0,
      revision: typeof snapshot.revision === "number" ? snapshot.revision : 0,
      capturedAt,
      hasTree: snapshot.hasTree === true,
      hasScreenshot: snapshot.hasScreenshot === true,
    }];
  }) : [];
  return {
    runtime: {
      status: optionalString(runtimeSource?.status) ?? "unavailable",
      ...(optionalString(runtimeSource?.hdcPath) ? { hdcPath: optionalString(runtimeSource?.hdcPath) } : {}),
      ...(errorSource ? { error: { code: optionalString(errorSource.code), message: optionalString(errorSource.message) } } : {}),
    },
    devices: Array.isArray(source?.devices) ? normalizeDevices(source.devices) : fallbackDevices,
    leases,
    controls: Array.isArray(source?.controls) ? source.controls.flatMap(item => {
      const control = recordOf(item);
      const serial = optionalString(control?.serial);
      const status = control?.status;
      return serial && (status === "stopping" || status === "recovering") ? [{ serial, status }] : [];
    }) : [],
    snapshots,
  };
}

function normalizeRuntimeCandidates(value: unknown): RuntimeCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const hdcPath = optionalString(source?.hdcPath);
    const sdkPath = optionalString(source?.sdkPath);
    if (!source || !hdcPath || !sdkPath) return [];
    const validSources: RuntimeCandidate["source"][] = ["selection", "environment", "config", "deveco", "path", "bundled"];
    const candidateSource = validSources.includes(source.source as RuntimeCandidate["source"])
      ? source.source as RuntimeCandidate["source"]
      : "path";
    return [{ hdcPath, sdkPath, source: candidateSource }];
  });
}

function normalizeVisionModels(value: unknown): VisionModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const provider = optionalString(source?.provider);
    const modelId = optionalString(source?.modelId);
    if (!source || !provider || !modelId) return [];
    return [{ provider, modelId, name: optionalString(source.name) ?? modelId }];
  });
}

function messageOf(error: unknown, fallback: string, chinese: boolean): string {
  return error instanceof HarmonyRequestError ? error.messageFor(chinese) : error instanceof Error ? error.message : fallback;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string } & T;
  if (!response.ok) {
    throw new HarmonyRequestError(payload.error, response.status);
  }
  return payload;
}

type HarmonyPanelProps = {
  active: boolean;
  maximized?: boolean;
  onMaximizedChange?: (maximized: boolean) => void;
  sessionRunning?: boolean;
  cwd?: string | null;
  onOpenFile?: (path: string, line: number) => void;
  onGuideAgent?: ((prompt?: string) => void) | undefined;
  onSnapshot?: (fingerprint: number) => void;
};

type FrameZoom = "fit" | "100" | "150" | "200";

export function HarmonyPanel({ active, maximized = false, onMaximizedChange, sessionRunning = false, cwd, onOpenFile, onGuideAgent, onSnapshot }: HarmonyPanelProps) {
  const { locale } = useI18n();
  const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const [profile, setProfile] = useState<RuntimeProfile | "web">("web");
  const [devices, setDevices] = useState<HarmonyDevice[]>([]);
  const [managerState, setManagerState] = useState<HarmonyState | null>(null);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [sdkPath, setSdkPath] = useState("");
  const [runtimeCandidates, setRuntimeCandidates] = useState<RuntimeCandidate[]>([]);
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModelKey, setVisionModelKey] = useState("");
  const [shareScreenshot, setShareScreenshot] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolTab, setToolTab] = useState<"apps" | "files" | "commands" | "scenarios" | "voice" | "logs" | "history" | "diagnostics" | "inputs" | "check">("scenarios");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsVisited, setToolsVisited] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const drawerId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const [frameZoom, setFrameZoom] = useState<FrameZoom>("fit");
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [tree, setTree] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const visibleError = error ?? deviceError;
  const [frameInteractionError, setFrameInteractionError] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [mediaNotice, setMediaNotice] = useState<MediaNotice | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number; geometryId?: string; generation: number; serial: string } | null>(null);
  const frameRef = useRef<HTMLCanvasElement>(null);
  const frameViewportRef = useRef<HTMLDivElement>(null);
  const framePanRef = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);

  useEffect(() => {
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

  const holder = managerState?.leases.find((item) => item.serial === selectedSerial);
  const controlStatus = managerState?.controls.find(item => item.serial === selectedSerial)?.status;
  const { lease, ownerId, clearControl, ensureControl, canControl, blocked } = useHarmonyManualControl({
    active: active && desktopAvailable, serial: selectedSerial, generation: selectedGeneration,
    online: Boolean(selectedOnline), holder, chinese, controlStatus,
  });
  const openTools = (tab = toolTab) => { setToolTab(tab); setToolsVisited(true); setToolsOpen(true); setSettingsOpen(false); };
  const closeTools = () => { setToolsOpen(false); toolsButtonRef.current?.focus(); };
  useEffect(() => {
    if (!toolsOpen) return;
    const tab = ["diagnostics", "inputs", "check"].includes(toolTab) ? "apps" : toolTab;
    document.getElementById(`${drawerId}-${tab}`)?.focus({ preventScroll: true });
  }, [toolsOpen, toolTab, drawerId]);

  // Tell the isolating boundary whenever a fresh poll replaced the panel data
  // so it can automatically retry rendering after transient bad payloads.
  useEffect(() => {
    if (!onSnapshot) return;
    const fingerprint = devices.reduce((acc, device) => acc + device.serial.length + device.generation, 0)
      + (managerState?.runtime.status.length ?? 0)
      + (managerState?.leases.length ?? 0)
      + (managerState?.snapshots.length ?? 0);
    onSnapshot(fingerprint);
  }, [devices, managerState, onSnapshot]);
  const {
    frame: liveFrame,
    status: frameStatus,
    mode: frameMode,
    error: frameLoadError,
    refresh: requestFrame,
  } = useHarmonyLiveFrame({
    active: active && desktopAvailable,
    enabled: Boolean(selectedOnline),
    serial: selectedSerial,
    generation: selectedGeneration,
    canvasRef: frameRef,
    fallbackError: copy("投屏暂不可用，请检查设备授权与 HDC。", "Live view unavailable. Check device authorization and HDC."),
  });

  useEffect(() => {
    setFrameSize(liveFrame ? { width: liveFrame.width, height: liveFrame.height } : null);
    if (liveFrame) setFrameInteractionError(null);
  }, [liveFrame]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!desktopAvailable) return;
    try {
      const devicePayload = await jsonRequest<unknown>("/api/harmony/devices", { signal });
      const payloadRecord = recordOf(devicePayload);
      const stateRecord = recordOf(payloadRecord?.state);
      const rawDevices = Array.isArray(payloadRecord?.devices) ? payloadRecord.devices : stateRecord?.devices;
      if (!Array.isArray(rawDevices)) throw new Error(copy("设备服务返回了无效数据", "The device service returned invalid data"));
      const nextDevices = normalizeDevices(rawDevices);
      setDevices(nextDevices);
      setManagerState(normalizeHarmonyState(payloadRecord?.state, nextDevices));
      setSelectedSerial((current) => current && nextDevices.some((device) => device.serial === current)
        ? current
        : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
      setDeviceError(null);
    } catch (refreshError) {
      if (signal?.aborted) return;
      setDeviceError(messageOf(refreshError, copy("无法读取设备状态", "Unable to read device state"), chinese));
    }
  }, [copy, desktopAvailable, chinese]);

  const loadConfig = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const [payloadValue, modelPayloadValue] = await Promise.all([
        jsonRequest<unknown>("/api/harmony/config"),
        jsonRequest<unknown>("/api/harmony/vision-models"),
      ]);
      const payload = recordOf(payloadValue);
      const modelPayload = recordOf(modelPayloadValue);
      const config = recordOf(payload?.config);
      const diagnostics = normalizeHarmonyState(payload?.diagnostics);
      const candidates = normalizeRuntimeCandidates(payload?.candidates);
      setRuntimeCandidates(candidates);
      setSdkPath(optionalString(config?.hdcPath) ?? diagnostics.runtime.hdcPath ?? candidates[0]?.hdcPath ?? "");
      setVisionModels(normalizeVisionModels(modelPayload?.models));
      const vision = recordOf(config?.vision);
      const provider = optionalString(vision?.provider);
      const modelId = optionalString(vision?.modelId);
      setVisionEnabled(vision?.enabled === true && Boolean(provider && modelId));
      setVisionModelKey(provider && modelId ? `${provider}\u0000${modelId}` : "");
      setShareScreenshot(vision?.shareScreenshotWithActionModel === true);
      setDiagnostics(payload?.diagnostics ?? null);
    } catch (configError) {
      setError(messageOf(configError, copy("无法读取 SDK 配置", "Unable to read SDK configuration"), chinese));
    }
  }, [copy, desktopAvailable, chinese]);

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
        const metadata = recordOf(JSON.parse(event.data));
        if (!metadata) return;
        if (metadata.type === "devices" && Array.isArray(metadata.devices)) {
          const nextDevices = normalizeDevices(metadata.devices);
          setDevices(nextDevices);
          setSelectedSerial((current) => current && nextDevices.some((device) => device.serial === current)
            ? current
            : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
        } else if (metadata.type === "state" && metadata.state) {
          setManagerState(normalizeHarmonyState(metadata.state));
        } else if (metadata.type !== "connected" && metadata.type !== "heartbeat" && metadata.type !== "snapshot") {
          void jsonRequest<unknown>(`/api/harmony/state${selectedSerial ? `?serial=${encodeURIComponent(selectedSerial)}` : ""}`)
            .then((payload) => setManagerState(normalizeHarmonyState(recordOf(payload)?.state)))
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
    if (!active || !desktopAvailable || !selectedSerial) {
      setRecording(null);
      return;
    }
    let disposed = false;
    const loadMedia = () => jsonRequest<{ recording: RecordingState | null }>(`/api/harmony/media?serial=${encodeURIComponent(selectedSerial)}`)
      .then((payload) => { if (!disposed) setRecording(payload.recording); })
      .catch(() => undefined);
    void loadMedia();
    const timer = window.setInterval(() => { void loadMedia(); }, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active, desktopAvailable, selectedSerial]);

  useEffect(() => {
    if (!recording) {
      setRecordingElapsed(0);
      return;
    }
    const startedAt = Date.parse(recording.startedAt);
    const updateElapsed = () => setRecordingElapsed(Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, after?: (value: T) => void | Promise<void>) => {
    setBusy(true);
    try {
      const value = await operation();
      await after?.(value);
      setError(null);
      return value;
    } catch (operationError) {
      setError(messageOf(operationError, copy("设备操作失败", "Device operation failed"), chinese));
      if (operationError instanceof HarmonyRequestError && operationError.controlStatus) void refresh();
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [copy, chinese, refresh]);

  const chooseRuntimePath = useCallback(async (kind: "sdk" | "hdc") => {
    const selectedPath = await window.piDesktop?.selectHarmonyRuntimePath?.(kind);
    if (!selectedPath) return;
    await run(async () => {
      const payload = await jsonRequest<unknown>("/api/harmony/runtime-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectionPath: selectedPath }),
      });
      const candidates = normalizeRuntimeCandidates(recordOf(payload)?.candidates);
      const selected = candidates.find((candidate) => candidate.source === "selection");
      if (!selected) throw new Error(copy("所选位置中没有找到 hdc", "No hdc executable was found in the selected location"));
      setRuntimeCandidates(candidates);
      setSdkPath(selected.hdcPath);
    });
  }, [copy, run]);

  const copyMediaArtifact = async (artifact: MediaArtifact) => {
    const label = artifact.kind === "screenshot" ? copy("截图", "Screenshot") : copy("录屏文件", "Recording file");
    openTools("history");
    setMediaNotice({ artifact, copyStatus: "copying", message: copy(`${label}已保存，正在复制…`, `${label} saved. Copying…`) });
    try {
      const writeMedia = window.piDesktop?.clipboard?.copyHarmonyMedia;
      if (!writeMedia) throw new Error("Media clipboard unavailable");
      await writeMedia({ kind: artifact.kind, path: artifact.path });
      setMediaNotice((current) => current?.artifact === artifact
        ? { artifact, copyStatus: "copied", message: copy(`${label}已保存并复制到剪贴板`, `${label} saved and copied to clipboard`) }
        : current);
    } catch {
      // Saving succeeded even if clipboard access failed; keep the path available.
      setMediaNotice((current) => current?.artifact === artifact
        ? { artifact, copyStatus: "failed", message: copy(`${label}已保存，但复制失败，可重试或复制路径。`, `${label} saved, but copying failed. Retry or copy the path.`) }
        : current);
    }
  };

  const copyMediaPath = async () => {
    const artifact = mediaNotice?.artifact;
    if (!artifact) return;
    const updatePathStatus = (pathStatus: MediaNotice["pathStatus"]) => setMediaNotice((current) => current?.artifact === artifact ? { ...current, pathStatus } : current);
    updatePathStatus("copying");
    try {
      await copyText(artifact.path);
      updatePathStatus("copied");
    } catch {
      updatePathStatus("failed");
    }
  };

  const action = (input: Record<string, unknown>) => {
    if (!selectedSerial || !canControl) return Promise.resolve(undefined);
    return run(async () => {
      const leaseToken = await ensureControl();
      return jsonRequest("/api/harmony/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: selectedSerial, leaseToken, ...input }),
      });
    });
  };

  const mediaAction = (mediaActionName: "capture_screenshot" | "start_recording" | "stop_recording") => {
    if (!selectedSerial) return;
    void run(async () => {
      const leaseToken = mediaActionName === "start_recording" ? await ensureControl() : undefined;
      return jsonRequest<{ artifact?: MediaArtifact; recording?: RecordingState }>("/api/harmony/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mediaActionName, serial: selectedSerial, leaseToken, ownerId }),
      });
    }, async (payload) => {
      if (payload.recording) {
        setRecording(payload.recording);
        setMediaNotice({ message: copy("录屏已开始", "Recording started") });
      } else if (payload.artifact) {
        if (payload.artifact.kind === "recording") setRecording(null);
        await copyMediaArtifact(payload.artifact);
      }
    });
  };

  const stopDevice = () => {
    clearControl();
    void run(() => jsonRequest("/api/harmony/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop_device", serial: selectedSerial }),
    }), () => { setRecording(null); void refresh(); });
  };

  const saveSettings = () => void run(async () => {
    const [provider, modelId] = visionModelKey.split("\u0000");
    const payloadValue = await jsonRequest<unknown>("/api/harmony/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hdcPath: sdkPath.trim() || null,
        vision: visionEnabled ? { enabled: true, provider, modelId, shareScreenshotWithActionModel: shareScreenshot } : null,
      }),
    });
    const payload = recordOf(payloadValue);
    const config = recordOf(payload?.config);
    const candidates = normalizeRuntimeCandidates(payload?.candidates);
    setSdkPath(optionalString(config?.hdcPath) ?? candidates[0]?.hdcPath ?? "");
    setRuntimeCandidates(candidates);
    setDiagnostics(payload?.diagnostics ?? null);
    await refresh();
    return payloadValue;
  }, () => setSettingsOpen(false));

  const imagePoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = frameRef.current;
    if (!canvas || !frameSize) return null;
    const bounds = canvas.getBoundingClientRect();
    return framePointFromClient(event.clientX, event.clientY, bounds, frameSize.width, frameSize.height);
  };

  const formatRecordingElapsed = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const panFrame = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = framePanRef.current;
    const viewport = frameViewportRef.current;
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return;
    viewport.scrollLeft = pan.scrollLeft + pan.startX - event.clientX;
    viewport.scrollTop = pan.scrollTop + pan.startY - event.clientY;
  };

  if (profile === "web") {
    return <div className={styles.gate}>
      <AliIcon name="mobile" size={34} />
      <h2>{copy("鸿蒙设备控制", "Harmony device control")}</h2>
      <p>{brandText(copy("该能力仅在 Piora 桌面应用中提供。", "This capability is available only in the Piora desktop app."))}</p>
      {visibleError ? <div className={styles.error} role="alert">{visibleError}</div> : null}
    </div>;
  }

  const snapshot = managerState?.snapshots.find((item) => item.serial === selectedSerial);
  const frameMatchesDevice = Boolean(liveFrame && selected && liveFrame.serial === selected.serial && liveFrame.generation === selected.generation);
  const frameError = frameInteractionError ?? frameLoadError;
  const agentHasControl = holder?.owner.kind === "agent";
  const canPointControl = Boolean(!busy && canControl && frameStatus === "live" && frameMatchesDevice && liveFrame?.geometryId && selected?.capabilities.tap);
  const runtimeReady = managerState?.runtime.status === "ready";
  const deviceStateLabel = selected?.state === "online"
    ? copy("已连接", "Connected")
    : selected?.state === "unauthorized"
      ? copy("等待手机授权", "Authorization needed")
      : selected
        ? copy("设备离线", "Offline")
        : copy("未连接", "Not connected");
  const visionModel = visionModels.find((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey);
  const zoomScale = frameZoom === "fit" ? null : Number(frameZoom) / 100;
  const frameCanvasStyle = zoomScale && frameSize
    ? { width: frameSize.width * zoomScale, height: frameSize.height * zoomScale, maxWidth: "none", maxHeight: "none" }
    : undefined;
  const ownsRecording = recording?.ownerId === ownerId;

  return <div className={styles.root}>
    <header className={styles.deviceHeader}>
      <div className={styles.deviceIdentity}>
        <span className={styles.deviceMark}><AliIcon name="mobile" size={15} /></span>
        <select aria-label={copy("选择设备", "Select device")} value={selectedSerial} onChange={(event) => {
          const nextSerial = event.target.value;
          clearControl();
          pointerStartRef.current = null;
          setSelectedSerial(nextSerial);
          setTree(null);
          setFrameSize(null);
          setRecording(null);
          setMediaNotice(null);
          setText("");
          setTextOpen(false);
          setFrameZoom("fit");
        }}>
          {!devices.length ? <option value="">{copy("没有设备", "No device")}</option> : null}
          {devices.map((device) => <option key={device.serial} value={device.serial}>{formatHarmonyDeviceLabel(device)}</option>)}
        </select>
        <span className={styles.deviceState} data-state={selected?.state ?? "unknown"}><i />{deviceStateLabel}</span>
      </div>
      <div className={styles.toolbarActions}>
        {onMaximizedChange ? <button className={styles.focusButton} aria-label={maximized ? copy("返回双栏", "Return to split view") : copy("专注投屏", "Focus screen")} type="button" onClick={() => onMaximizedChange(!maximized)} title={maximized ? copy("返回双栏", "Return to split view") : copy("专注投屏", "Focus screen")}>
          <AliIcon name={maximized ? "fullscreen-exit" : "fullscreen"} size={16} />
        </button> : null}
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

      <div className={styles.settingGroup}>
        <div className={styles.settingsLinks}>
          <button type="button" onClick={() => openTools("diagnostics")}>{copy("连接诊断", "Diagnostics")}</button>
          <button type="button" onClick={() => openTools("inputs")}>{copy("按键与触摸校准", "Input calibration")}</button>
          <button type="button" onClick={() => openTools("check")}>{copy("代码检查", "Code checks")}</button>
        </div>
        <p className={styles.inlineHint}>{copy("锁屏时请在手机上手动解锁。投屏不会自动唤醒或解锁。", "Unlock on the phone when needed. Mirroring never wakes or unlocks it.")}</p>
      </div>
      <div className={styles.settingsFooter}>
        <button type="button" onClick={() => setSettingsOpen(false)}>{copy("取消", "Cancel")}</button>
        <button className={styles.primaryButton} type="button" disabled={busy || (visionEnabled && !visionModelKey)} onClick={saveSettings}>{copy("保存", "Save")}</button>
      </div>
    </section> : null}

    <main className={styles.workspace}>
      <div className={styles.screenPane}>
        {controlStatus ? <div className={styles.activityBar} role="status">
          <span>{controlStatus === "stopping" ? copy("正在停止设备操作，请稍候…", "Stopping device operations…") : copy("设备清理尚未确认，暂不能操作或开始录屏", "Device cleanup is unconfirmed. Input and new recordings are paused.")}</span>
          {controlStatus === "recovering" ? <button type="button" onClick={() => openTools("diagnostics")}>{copy("检查并恢复", "Check and recover")}</button> : null}
        </div> : blocked ? <div className={styles.activityBar} data-agent-control={agentHasControl}>
          <span><AliIcon name={agentHasControl ? "robot" : "mobile"} size={13} />{agentHasControl ? copy("AI 正在操作", "AI is operating") : copy("其他窗口正在操作", "Another window is operating")}</span>
          {agentHasControl && onGuideAgent ? <button type="button" onClick={() => onGuideAgent()}>{copy("指导 AI", "Guide AI")}</button> : null}
          <button type="button" disabled={busy} onClick={() => void run(() => ensureControl(true), () => { void refresh(); })}>{copy("停止并接管", "Stop and take over")}</button>
        </div> : null}
    <div className={styles.deviceArea}>
      <div className={styles.zoomControls}>
        <select aria-label={copy("画面缩放", "Screen zoom")} value={frameZoom} onChange={(event) => setFrameZoom(event.target.value as FrameZoom)}>
          <option value="fit">{copy("适应窗口", "Fit")}</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option>
        </select>
      </div>
      <div
        ref={frameViewportRef}
        className={styles.frameViewport}
        data-pannable={frameZoom !== "fit" && !canPointControl ? "true" : "false"}
        onPointerDown={(event) => {
          if (frameZoom === "fit" || canPointControl) return;
          const viewport = frameViewportRef.current;
          if (!viewport) return;
          framePanRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={panFrame}
        onPointerUp={(event) => { if (framePanRef.current?.pointerId === event.pointerId) framePanRef.current = null; }}
        onPointerCancel={() => { framePanRef.current = null; }}
      >
      <div className={styles.frame} data-enabled={canPointControl ? "true" : "false"} data-zoom={frameZoom}>
        {selectedOnline ? <div className={styles.frameStatus} data-status={frameStatus} aria-live="polite">
          <span />{frameStatus === "error"
            ? frameMode === "frames" ? copy("兼容投屏重试中", "Retrying compatible view") : copy("视频流重连中", "Reconnecting stream")
            : frameStatus === "loading"
              ? frameMode === "frames" ? copy("切换兼容投屏", "Switching to compatible view") : copy("视频流连接中", "Connecting stream")
              : frameMode === "frames" ? copy("兼容投屏 · 自动刷新", "Compatible view · auto refresh") : copy("实时视频流", "Live video")}
          {frameSize ? ` · ${frameSize.width}×${frameSize.height}` : ""}
        </div> : null}
        {selectedOnline ? <canvas
          ref={frameRef}
          style={frameCanvasStyle}
          role="img"
          aria-label={copy("手机实时视频流", "Live device video stream")}
          onPointerDown={(event) => {
            if (!canPointControl) return;
            const point = imagePoint(event);
            pointerStartRef.current = point && liveFrame ? { ...point, pointerId: event.pointerId, geometryId: liveFrame.geometryId, generation: liveFrame.generation, serial: selectedSerial } : null;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { pointerStartRef.current = null; }}
          onLostPointerCapture={() => { pointerStartRef.current = null; }}
          onPointerUp={(event) => {
            const from = pointerStartRef.current;
            const to = imagePoint(event);
            pointerStartRef.current = null;
            if (!from || from.pointerId !== event.pointerId || !to || !canPointControl || !liveFrame || !frameMatchesDevice || from.serial !== selectedSerial || from.generation !== liveFrame.generation || from.geometryId !== liveFrame.geometryId) return;
            if (!liveFrame.geometryId) {
              setFrameInteractionError(copy("正在自动校准点击位置，请稍候。", "Calibrating touch coordinates automatically. Please wait."));
              return;
            }
            const distance = Math.hypot(to.x - from.x, to.y - from.y);
            if (distance > 12 && !selected?.capabilities.swipe) {
              setFrameInteractionError(copy("当前设备不支持滑动注入。", "This device does not support swipe injection."));
              return;
            }
            void action(distance > 12
              ? { action: "swipe", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: 300, generation: liveFrame.generation, coordinateSpace: "frame", geometryId: liveFrame.geometryId }
              : { action: "tap", x: to.x, y: to.y, generation: liveFrame.generation, coordinateSpace: "frame", geometryId: liveFrame.geometryId });
          }}
        /> : <div className={styles.frameEmpty}>
          <AliIcon name="mobile" size={28} />
          <strong>{copy("连接一台设备", "Connect a device")}</strong>
          <span>{copy("实时视频会显示在这里", "The live video stream will appear here")}</span>
          {!runtimeReady ? <button type="button" onClick={() => setSettingsOpen(true)}>{copy("打开设置", "Open settings")}</button> : null}
        </div>}
        {frameError ? <div className={styles.frameError} role="status">{frameError}</div> : null}
      </div>
      </div>
    </div>


        {textOpen ? <form className={styles.textControl} onSubmit={(event) => { event.preventDefault(); if (text) void action({ action: "input_text", text }).then(result => { if (result !== undefined) setText(""); }); }}>
          <input autoFocus aria-label={copy("输入到手机", "Type on device")} placeholder={copy("输入文字，回车发送", "Type text and press Enter")} value={text} onChange={event => setText(event.target.value)} />
          <button className={styles.iconButton} type="submit" disabled={!canControl || !text || busy || !selected?.capabilities.inputText} aria-label={copy("发送到手机", "Send to device")}><AliIcon name="enter" size={14} /></button>
          <button className={styles.iconButton} type="button" onClick={() => setTextOpen(false)} aria-label={copy("关闭输入", "Close input")}><AliIcon name="close" size={13} /></button>
        </form> : null}
        <div className={styles.actionBar}>
          <div className={styles.keyRow} aria-label={copy("系统按键", "System keys")}>
            {(["back", "home", "recents"] as const).map((key, index) => <button key={key} type="button" disabled={!canControl || busy || !selected?.capabilities.keys} onClick={() => void action({ action: "press_key", key })} title={(chinese ? ["返回", "主页", "最近任务"] : ["Back", "Home", "Recents"])[index]} aria-label={(chinese ? ["返回", "主页", "最近任务"] : ["Back", "Home", "Recents"])[index]}><AliIcon name={(["arrowleft", "home", "layout"] as const)[index]} size={15} /></button>)}
            <button type="button" disabled={!canControl || !selected?.capabilities.inputText} aria-pressed={textOpen} aria-label={copy("输入文字", "Type text")} title={copy("输入文字", "Type text")} onClick={() => setTextOpen(open => !open)}><AliIcon name="edit" size={15} /></button>
          </div>
          <span className={styles.actionDivider} />
          <button type="button" disabled={!canScreenshot || busy} onClick={() => mediaAction("capture_screenshot")}><AliIcon name="save" size={15} />{copy("截图", "Screenshot")}</button>
          {recording ? <button className={styles.recordingButton} type="button" disabled={busy || !ownsRecording} onClick={() => mediaAction("stop_recording")}><AliIcon name="stop" size={15} />{ownsRecording ? copy(`停止录屏 · ${formatRecordingElapsed(recordingElapsed)}`, `Stop recording · ${formatRecordingElapsed(recordingElapsed)}`) : copy("AI 正在录屏", "AI recording")}</button>
            : <button type="button" aria-label={copy("开始录屏", "Start recording")} disabled={!canControl || busy} onClick={() => mediaAction("start_recording")}><AliIcon name="play" size={15} />{copy("录屏", "Record")}</button>}
          {lease || holder || busy ? <button className={styles.stopButton} type="button" disabled={!selectedOnline} onClick={stopDevice} aria-label={copy("停止当前设备操作", "Stop this device")} title={copy("停止当前设备操作", "Stop this device")}><AliIcon name="stop" size={15} /></button> : null}
        </div>
      </div>
      <section id={drawerId} className={styles.toolDrawer} hidden={!toolsOpen} aria-label={copy("设备工具", "Device tools")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeTools(); } }}>
        <div className={styles.drawerHeading}><strong>{copy("工具", "Tools")}</strong><button className={styles.iconButton} type="button" onClick={closeTools} aria-label={copy("关闭工具", "Close tools")}><AliIcon name="close" size={15} /></button></div>
        <div className={styles.drawerTabs} role="tablist" aria-label={copy("设备工具分类", "Device tool categories")}>
          {(["apps", "files", "commands", "scenarios", "voice", "logs", "history"] as const).map((tab, index) => <button id={`${drawerId}-${tab}`} aria-controls={`${drawerId}-content`} key={tab} role="tab" type="button" tabIndex={toolTab === tab || (index === 0 && ["diagnostics", "inputs", "check"].includes(toolTab)) ? 0 : -1} aria-selected={toolTab === tab} onClick={() => setToolTab(tab)} onKeyDown={event => {
            const tabs = ["apps", "files", "commands", "scenarios", "voice", "logs", "history"] as const;
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); setToolTab(tabs[next]); document.getElementById(`${drawerId}-${tabs[next]}`)?.focus(); }
          }}>{(chinese ? ["应用", "文件", "命令", "测试", "语音", "日志", "记录"] : ["Apps", "Files", "Commands", "Tests", "Voice", "Logs", "History"])[index]}</button>)}
        </div>
        <div className={styles.drawerBody} id={`${drawerId}-content`} role="tabpanel" aria-label={copy("工具内容", "Tool content")}>
          {["diagnostics", "inputs", "check"].includes(toolTab) ? <div className={styles.toolTitle}><strong>{toolTab === "diagnostics" ? copy("连接诊断", "Diagnostics") : toolTab === "inputs" ? copy("按键与触摸校准", "Input calibration") : copy("代码检查", "Code checks")}</strong><button type="button" onClick={() => setToolTab("scenarios")}>{copy("返回测试", "Back to tests")}</button></div> : null}
          {toolTab === "history" ? <div className={styles.mediaWorkspace}>
          {mediaNotice ? <div className={styles.mediaNotice} role="status" aria-live="polite">
            <span>{mediaNotice.message}</span>
            {mediaNotice.artifact ? <>
              <div className={styles.mediaPath}>
                <span>{copy("保存路径", "Saved to")}</span>
                <code>{mediaNotice.artifact.path}</code>
              </div>
              <div className={styles.mediaNoticeActions}>
                <button type="button" disabled={mediaNotice.copyStatus === "copying" || mediaNotice.pathStatus === "copying"} onClick={() => void copyMediaPath()}>
                  <AliIcon name="copy" size={13} />{mediaNotice.pathStatus === "copied" ? copy("路径已复制", "Path copied") : copy("复制路径", "Copy path")}
                </button>
                {mediaNotice.copyStatus === "failed" ? <button type="button" disabled={busy || mediaNotice.pathStatus === "copying"} onClick={() => void run(() => copyMediaArtifact(mediaNotice.artifact!))}>{copy("重新复制", "Retry copy")}</button> : null}
                {mediaNotice.pathStatus === "failed" ? <span>{copy("路径复制失败，请重试", "Could not copy the path. Please retry.")}</span> : null}
              </div>
            </> : null}
          </div> : <div className={styles.mediaEmpty}>{copy("截图和录屏保存后会显示在这里。", "Saved screenshots and recordings appear here.")}</div>}

          </div> : null}
          {toolsVisited ? <WorkbenchTools key={selectedSerial} tab={toolTab} serial={selectedSerial} active={active} chinese={chinese} canControl={canControl} ensureControl={ensureControl} geometryId={liveFrame?.geometryId} cwd={cwd} ownerId={ownerId} onCleanupConfirmed={async () => { setError(null); await refresh(); }} /> : null}
          {toolTab === "logs" ? <HarmonyLogViewer active={active && toolsOpen} serial={selectedSerial} online={Boolean(selectedOnline)} copy={copy} /> : null}
          {toolTab === "check" ? <HarmonyCheckPanel active={active && toolsOpen} cwd={cwd} onOpenFile={onOpenFile} onGuideAgent={onGuideAgent} /> : null}
          {toolTab === "diagnostics" ? <div className={styles.moreBody}>
            <button type="button" disabled={!canControl || busy} onClick={() => void action({ action: "initialize_mirror" }).then(result => { if (result !== undefined) requestFrame(); })}>{copy("初始化投屏服务", "Initialize video service")}</button>
            <button type="button" disabled={!selectedOnline || busy} onClick={requestFrame}>{copy("重连视频流", "Reconnect video")}</button>
            <button type="button" disabled={!selectedOnline || busy || !selected?.capabilities.uiTree} onClick={() => void run(() => jsonRequest<{ snapshot: unknown }>(`/api/harmony/tree?serial=${encodeURIComponent(selectedSerial)}`), payload => setTree(payload.snapshot))}>{copy("读取界面结构", "Read interface structure")}</button>
            <details className={styles.diagnostics}><summary>{copy("开发者信息", "Developer details")}</summary><pre>{JSON.stringify({ selected, holder, snapshot, diagnostics, tree }, null, 2)}</pre></details>
            <button className={styles.stopButton} type="button" disabled={busy} onClick={() => { clearControl(); void run(() => jsonRequest("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "emergency_stop", reason: "desktop-global-stop" }) })); }}>{copy("停止所有设备操作", "Stop all devices")}</button>
          </div> : null}
        </div>
      </section>
    </main>
    <footer className={styles.statusBar}>
      <span title={copy("锁屏时请手动解锁，投屏不会自动唤醒或解锁。", "Unlock manually. Mirroring never wakes or unlocks your phone.")}>{controlStatus ? controlStatus === "stopping" ? copy("正在停止", "Stopping") : copy("等待恢复", "Recovery required") : blocked ? copy("正在旁观", "Observing") : selectedOnline && frameStatus === "live" && frameMatchesDevice ? selected?.capabilities.tap ? liveFrame?.geometryId ? copy("可直接点击、滑动", "Touch and swipe ready") : copy("正在自动校准点击位置", "Calibrating touch coordinates") : copy("投屏已连接", "Mirror connected") : selectedOnline ? copy("等待实时画面", "Waiting for live view") : sessionRunning ? copy("等待设备连接", "Waiting for a device") : copy("请连接设备", "Connect a device")}</span>
      <div className={styles.footerActions}>
      {lease || holder || busy ? <button className={styles.stopButton} type="button" onClick={stopDevice} aria-label={copy("停止设备任务", "Stop device task")} title={copy("停止设备任务", "Stop device task")}><AliIcon name="stop" size={13} /></button> : null}
      <button ref={toolsButtonRef} type="button" aria-expanded={toolsOpen} aria-controls={drawerId} onClick={() => toolsOpen ? closeTools() : openTools()}>{copy("工具", "Tools")}<AliIcon name={toolsOpen ? "arrowdown" : "arrowup"} size={13} /></button>
      </div>
    </footer>
    {visibleError ? <div className={styles.error} role="alert">{visibleError}<button className={styles.iconButton} type="button" onClick={() => { setError(null); setDeviceError(null); }} aria-label={copy("关闭提示", "Dismiss message")}><AliIcon name="close" size={12} /></button></div> : null}
  </div>;
}

type HarmonyPanelBoundaryProps = { active: boolean; resetKey?: string; children: ReactNode };
type HarmonyPanelBoundaryState = { error: Error | null };

class HarmonyPanelErrorBoundary extends Component<HarmonyPanelBoundaryProps, HarmonyPanelBoundaryState> {
  state: HarmonyPanelBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): HarmonyPanelBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Harmony panel render failed", error, info.componentStack);
  }

  componentDidUpdate(previous: HarmonyPanelBoundaryProps): void {
    if (!this.state.error) return;
    // Reset when the tab closes, or when a fresh poll delivered new data.
    if ((previous.active && !this.props.active) || previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const chinese = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
    return <div className={styles.gate} role="alert">
      <AliIcon name="warning" size={34} />
      <h2>{chinese ? "鸿蒙设备面板暂不可用" : "Harmony panel is temporarily unavailable"}</h2>
      <p>{chinese ? "设备面板已被隔离，当前会话不会中断。" : "The device panel was isolated; your active session is still running."}</p>
      <button type="button" onClick={() => this.setState({ error: null })}>{chinese ? "重试面板" : "Retry panel"}</button>
    </div>;
  }
}

export function SafeHarmonyPanel({ active, ...props }: Omit<HarmonyPanelProps, "onSnapshot">) {
  const [snapshot, setSnapshot] = useState(0);
  const handleSnapshot = useCallback((fingerprint: number) => {
    setSnapshot((current) => (current === fingerprint ? current : fingerprint));
  }, []);
  return <HarmonyPanelErrorBoundary active={active} resetKey={String(snapshot)}>
    <HarmonyPanel {...props} active={active} onSnapshot={handleSnapshot} />
  </HarmonyPanelErrorBoundary>;
}
