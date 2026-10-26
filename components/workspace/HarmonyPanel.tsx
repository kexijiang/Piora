"use client";

import { brandText } from "@/lib/branding";

import { Component, useCallback, useEffect, useId, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { formatShortcutBinding, isMacPlatform, shortcutMatchesEvent, shouldPreserveApplicationShortcut } from "@/lib/keyboard-shortcuts";
import { useHarmonyManualControl } from "@/hooks/useHarmonyManualControl";
import { useHarmonyWindow } from "@/hooks/useHarmonyWindow";
import { useHarmonyMedia } from "@/hooks/useHarmonyMedia";
import { PioraMessageHost, showPioraMessage } from "../PioraMessage";
import { HarmonySettingsSurface } from "./harmony/HarmonySettingsSurface";
import { HarmonyStorageSettings } from "../HarmonyStorageSettings";
import dynamic from "next/dynamic";
import { formatHarmonyDeviceLabel } from "@/lib/harmony/device-label";
import { currentHarmonyResponseSample, normalizeHarmonyResponseSample, type HarmonyResponseSample } from "@/lib/harmony/device-connection";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { AliIcon } from "../AliIcon";
import { HarmonyLogViewer } from "./HarmonyLogViewer";
const MirrorWindow = dynamic(() => import("./harmony/MirrorWindow").then(module => module.MirrorWindow), { ssr: false });
const WorkbenchTools = dynamic(() => import("./harmony/WorkbenchTools").then(module => module.WorkbenchTools), { ssr: false });
import { MediaHistory } from "./harmony/MediaHistory";
import { TcpDeviceConnection } from "./harmony/TcpDeviceConnection";
import styles from "./HarmonyPanel.module.css";

type RuntimeProfile = "normal" | "device-control";
type HarmonyDevice = {
  serial: string;
  state: "online" | "unauthorized" | "offline" | "unknown";
  connectionIssue?: "hdc-channel-not-ready";
  transport?: "usb" | "tcp" | "unknown";
  transportEvidence?: "hdc" | "endpoint" | "unavailable";
  responseSample?: HarmonyResponseSample;
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
  return value.flatMap<HarmonyDevice>((item) => {
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
      ...(state === "unknown" && source.connectionIssue === "hdc-channel-not-ready" ? { connectionIssue: source.connectionIssue } : {}),
      transport: source.transport === "usb" || source.transport === "tcp" ? source.transport : "unknown",
      transportEvidence: source.transportEvidence === "hdc" || source.transportEvidence === "endpoint" ? source.transportEvidence : "unavailable",
      responseSample: normalizeHarmonyResponseSample(source.responseSample),
      ...(optionalString(source.name) ? { name: optionalString(source.name) } : {}),
      ...(optionalString(source.model) ? { model: optionalString(source.model) } : {}),
      ...(optionalString(source.product) ? { product: optionalString(source.product) } : {}),
      ...(optionalString(source.osVersion) ? { osVersion: optionalString(source.osVersion) } : {}),
      generation: typeof source.generation === "number" && Number.isFinite(source.generation) ? source.generation : 0,
      capabilities,
    }];
  }).sort((a, b) => Number(b.state === "online") - Number(a.state === "online"));
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
  onOpenLocalTerminal?: () => void;
  onGuideAgent?: ((prompt?: string) => void) | undefined;
  onSnapshot?: (fingerprint: number) => void;
};



export function HarmonyPanel({ active, maximized = false, onMaximizedChange, cwd, onOpenLocalTerminal, onSnapshot }: HarmonyPanelProps) {
  const { locale } = useI18n();
  const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const { bindings } = useApplicationShortcuts();
  const screenshotBinding = bindings["harmony.screenshot"];
  const screenshotShortcutLabel = formatShortcutBinding(screenshotBinding, isMacPlatform(typeof window === "undefined" ? undefined : window.piDesktop?.platform));
  const panelRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<RuntimeProfile | "web">("web");
  const [devices, setDevices] = useState<HarmonyDevice[]>([]);
  const deviceOrder = useRef(new Map<string, number>());
  const orderedDevices = useCallback((value: unknown) => {
    const next = normalizeDevices(value);
    for (const device of next) if (!deviceOrder.current.has(device.serial)) deviceOrder.current.set(device.serial, deviceOrder.current.size);
    return next.sort((a, b) => Number(b.state === "online") - Number(a.state === "online") || deviceOrder.current.get(a.serial)! - deviceOrder.current.get(b.serial)!);
  }, []);
  const [managerState, setManagerState] = useState<HarmonyState | null>(null);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [sdkPath, setSdkPath] = useState("");
  const [videoProvider, setVideoProvider] = useState<"bundled" | "hos-scrcpy">("bundled");
  const [hosPackageDirectory, setHosPackageDirectory] = useState("");
  const [javaPath, setJavaPath] = useState("");
  const [runtimeCandidates, setRuntimeCandidates] = useState<RuntimeCandidate[]>([]);
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModelKey, setVisionModelKey] = useState("");
  const [shareScreenshot, setShareScreenshot] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolTab, setToolTab] = useState<"apps" | "files" | "databases" | "commands" | "scenarios" | "voice" | "logs" | "history" | "diagnostics" | "inputs" | "overview" | "media" | "tree">("overview");
  const [databaseSelection, setDatabaseSelection] = useState("");

  const [toolsVisited, setToolsVisited] = useState(false);
  const drawerId = useId();

  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const drawerScrollPositions = useRef<Record<string, number>>({});


  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [tree, setTree] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const visibleError = error ?? deviceError;








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

  const canScreenshot = Boolean(selectedOnline && selected?.capabilities.screenshot);

  useEffect(() => { setDatabaseSelection(""); }, [selectedSerial]);

  const holder = managerState?.leases.find((item) => item.serial === selectedSerial);
  const controlStatus = managerState?.controls.find(item => item.serial === selectedSerial)?.status;
  const { lease, ownerId, clearControl, ensureControl, canControl } = useHarmonyManualControl({
    active: active && desktopAvailable, serial: selectedSerial,
    online: Boolean(selectedOnline), holder, chinese, controlStatus,
  });
  const mirror = useHarmonyWindow();
  const [mirrorPresentation, setMirrorPresentation] = useState<"floating" | "sidebar">("floating");
  useEffect(() => { if (mirror?.presentation) setMirrorPresentation(mirror.presentation); }, [mirror?.presentation]);
  const openSelectedMirror = async () => {
    const bridge = window.piDesktop?.harmonyMirror; if (!bridge || !selectedSerial) return;
    try { if (mirrorPresentation === "sidebar") { await bridge.selectDevice(selectedSerial); await bridge.setPresentation("sidebar"); } else await bridge.open(selectedSerial); }
    catch (failure) { setError(String(failure)); }
  };
  const media = useHarmonyMedia(selectedSerial, mirror?.ownerId ?? ownerId, active && desktopAvailable, chinese);
  const { recording, elapsed: recordingElapsed, ownsRecording } = media;
  const screenshotBusy = media.busy === "capture_screenshot";
  const mediaAction = media.action;
  const [extraTabs, setExtraTabs] = useState<Array<typeof toolTab>>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tasksCount, setTasksCount] = useState(0);
  const [geometryId, setGeometryId] = useState<string>();
  useEffect(() => {
    setGeometryId(undefined);
    if (!active || !selectedOnline || !["inputs", "voice"].includes(toolTab)) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await jsonRequest<{ geometry?: { geometryId?: string } }>(`/api/harmony/geometry?serial=${encodeURIComponent(selectedSerial)}`, { signal: controller.signal });
        if (!controller.signal.aborted) setGeometryId(data.geometry?.geometryId);
      } catch { if (!controller.signal.aborted) setGeometryId(undefined); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => { void load(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, selectedOnline, selectedSerial, toolTab]);
  const reportedError = useRef<string | null>(null);
  useEffect(() => {
    if (!visibleError || visibleError === reportedError.current) return;
    reportedError.current = visibleError;
    void showPioraMessage({ title: copy("设备提示", "Device notice"), message: visibleError, tone: "error", actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] });
  }, [visibleError, copy]);
  useEffect(() => { if (!visibleError) reportedError.current = null; }, [visibleError]);
  useEffect(() => {
    if (!mirror?.serial) return;
    clearControl(); setSelectedSerial(mirror.serial); setTree(null);
  }, [mirror?.serial, clearControl]);
  useEffect(() => {
    if (selectedSerial && mirror && !mirror.serial) void window.piDesktop?.harmonyMirror?.selectDevice(selectedSerial).catch(failure => setError(String(failure)));
  }, [selectedSerial, mirror]);
  useEffect(() => {
    if (!active || !selectedSerial) return;
    const controller = new AbortController();
    const load = () => void jsonRequest<{ tasks?: Array<{ status: string }> }>(`/api/harmony/tasks?serial=${encodeURIComponent(selectedSerial)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTasksCount((data.tasks ?? []).filter(task => ["queued", "running", "stopping"].includes(task.status)).length); }).catch(() => undefined);
    load(); const timer = setInterval(load, 3000); return () => { controller.abort(); clearInterval(timer); };
  }, [active, selectedSerial]);
  const changeToolTab = (tab: typeof toolTab) => {
    if (drawerBodyRef.current) drawerScrollPositions.current[`${selectedSerial}:${toolTab}`] = drawerBodyRef.current.scrollTop;
    setToolTab(tab); setToolsVisited(true); setMoreOpen(false);
    if (!["overview", "apps", "files", "media"].includes(tab)) setExtraTabs(current => current.includes(tab) ? current : [...current, tab]);
  };
  const openTools = (tab = toolTab) => { changeToolTab(tab); setSettingsOpen(false); };
  useEffect(() => { if (drawerBodyRef.current) drawerBodyRef.current.scrollTop = drawerScrollPositions.current[`${selectedSerial}:${toolTab}`] ?? 0; }, [selectedSerial, toolTab]);

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
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!desktopAvailable) return;
    try {
      const devicePayload = await jsonRequest<unknown>("/api/harmony/devices", { signal });
      const payloadRecord = recordOf(devicePayload);
      const stateRecord = recordOf(payloadRecord?.state);
      const rawDevices = Array.isArray(payloadRecord?.devices) ? payloadRecord.devices : stateRecord?.devices;
      if (!Array.isArray(rawDevices)) throw new Error(copy("设备服务返回了无效数据", "The device service returned invalid data"));
      const nextDevices = orderedDevices(rawDevices);
      if (signal?.aborted) return;
      setDevices(nextDevices);
      setManagerState(normalizeHarmonyState(payloadRecord?.state, nextDevices));
      setSelectedSerial((current) => current ? current : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
      setDeviceError(null);
    } catch (refreshError) {
      if (signal?.aborted) return;
      setDeviceError(messageOf(refreshError, copy("无法读取设备状态", "Unable to read device state"), chinese));
    }
  }, [copy, desktopAvailable, chinese, orderedDevices]);

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
      const video = recordOf(config?.video);
      setVideoProvider(video?.provider === "hos-scrcpy" ? "hos-scrcpy" : "bundled");
      setHosPackageDirectory(optionalString(video?.packageDirectory) ?? "");
      setJavaPath(optionalString(video?.javaPath) ?? "");
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
          const nextDevices = orderedDevices(metadata.devices);
          setDevices(nextDevices);
          setSelectedSerial((current) => current ? current : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
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
  }, [active, desktopAvailable, loadConfig, refresh, selectedSerial, orderedDevices]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, after?: (value: T) => void | Promise<void>) => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
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
      busyRef.current = false;
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

  const initializeMirror = async () => {
    const result = await action({ action: "initialize_mirror" });
    if (result === undefined) return;
    await showPioraMessage({ title: copy("启用实时投屏", "Enable live video"), message: copy("请在手机上开始共享屏幕并确认授权，然后重新打开投屏。", "Start sharing on the phone and confirm consent, then reopen the mirror."), actions: [{ id: "done", label: copy("确定", "OK"), primary: true }] });
  };

  useEffect(() => {
    if (!active || !canScreenshot || !screenshotBinding) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || screenshotBusy || shouldPreserveApplicationShortcut(event.target)) return;
      if (!shortcutMatchesEvent(event, screenshotBinding, isMacPlatform(window.piDesktop?.platform))) return;
      if (!panelRef.current?.getClientRects().length) return;
      if ([...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(dialog => dialog.getClientRects().length > 0)) return;
      event.preventDefault();
      mediaAction("capture_screenshot");
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [active, canScreenshot, screenshotBinding, screenshotBusy, mediaAction]);

  const stopDevice = () => {
    clearControl();
    void run(() => jsonRequest("/api/harmony/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop_device", serial: selectedSerial }),
    }), () => { void media.refresh(); void refresh(); });
  };

  const saveSettings = () => void run(async () => {
    const [provider, modelId] = visionModelKey.split("\u0000");
    const payloadValue = await jsonRequest<unknown>("/api/harmony/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hdcPath: sdkPath.trim() || null,
        video: { provider: videoProvider, ...(videoProvider === "hos-scrcpy" ? { packageDirectory: hosPackageDirectory.trim(), ...(javaPath.trim() ? { javaPath: javaPath.trim() } : {}) } : {}) },
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

  const formatRecordingElapsed = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  if (profile === "web") {
    return <div className={styles.gate}>
      <AliIcon name="mobile" size={34} />
      <h2>{copy("鸿蒙设备控制", "Harmony device control")}</h2>
      <p>{brandText(copy("该能力仅在 Piora 桌面应用中提供。", "This capability is available only in the Piora desktop app."))}</p>
      {visibleError ? <div className={styles.error} role="alert">{visibleError}</div> : null}
    </div>;
  }

  const snapshot = managerState?.snapshots.find((item) => item.serial === selectedSerial);
  const deviceStateLabel = selected?.state === "online"
    ? copy("已连接", "Connected")
    : selected?.state === "unauthorized"
      ? copy("等待手机授权", "Authorization needed")
      : selected?.state === "offline"
        ? copy("设备离线", "Offline")
        : selected ? copy("连接未确认", "Connection unconfirmed") : copy("未连接", "Not connected");
  const visionModel = visionModels.find((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey);
  const responseSample = selectedOnline ? currentHarmonyResponseSample(selected?.responseSample) : undefined;
  const serialSuffix = selected ? devices.some(other => other.serial !== selected.serial && other.serial.slice(-6) === selected.serial.slice(-6)) ? selected.serial : selected.serial.slice(-6) : undefined;
  const connectionLabel = selected?.transport === "usb" ? "USB" : selected?.transport === "tcp" ? "TCP/Wi-Fi" : copy("连接方式未知", "Unknown transport");
  const connectionHint = selected?.transportEvidence === "endpoint"
    ? copy("连接方式根据 IP:端口标识推断，HDC 未直接标注。", "Transport inferred from IP:port; not reported directly by HDC.")
    : selected?.transportEvidence === "hdc" ? copy("连接方式由 HDC 标注。", "Transport reported by HDC.") : copy("HDC 未给出可核验的连接方式。", "HDC did not provide a verifiable transport.");

  return <div ref={panelRef} className={styles.root} data-maximized={maximized}>
    <header className={styles.deviceHeader}>
      <div className={styles.deviceIdentity}>
        <span className={styles.deviceMark}><AliIcon name="mobile" size={15} /></span>
        <div className={styles.deviceIdentityText}>
        <select aria-label={copy("选择设备", "Select device")} title={selected ? `${formatHarmonyDeviceLabel(selected)} · ${selected.serial}${selected.osVersion ? ` · ${selected.osVersion}` : ""}` : undefined} value={selectedSerial} onChange={(event) => {
          const nextSerial = event.target.value;
          if (window.piDesktop?.harmonyMirror) void window.piDesktop.harmonyMirror.selectDevice(nextSerial).catch(failure => setError(String(failure)));
          else { clearControl(); setSelectedSerial(nextSerial); setTree(null); }
        }}>
          {selectedSerial && !devices.some(device => device.serial === selectedSerial) ? <option value={selectedSerial}>{selectedSerial} · {copy("已断连", "Disconnected")}</option> : null}
          {!devices.length && !selectedSerial ? <option value="">{copy("没有设备", "No device")}</option> : null}
          {devices.map((device) => {
            const label = formatHarmonyDeviceLabel(device);
            const suffix = devices.some(other => other.serial !== device.serial && other.serial.slice(-6) === device.serial.slice(-6)) ? device.serial : device.serial.slice(-6);
            return <option key={device.serial} value={device.serial}>{label === device.serial ? label : `${label} · ${suffix}`}</option>;
          })}
        </select>
        <div className={styles.deviceConnection}>
        <span className={styles.deviceState} data-state={selected?.state ?? "unknown"}><i />{deviceStateLabel}</span>
        {selected && serialSuffix ? <span title={copy(`设备序列号：${selected.serial}`, `Device serial: ${selected.serial}`)}>{selected.serial === serialSuffix ? serialSuffix : `…${serialSuffix}`}</span> : null}
        {selected ? <span title={connectionHint}>{connectionLabel}</span> : null}
        {selectedOnline ? <span title={responseSample ? copy(`最近一次只读参数响应（包含主机 HDC 耗时），采样于 ${new Date(responseSample.sampledAt).toLocaleString()}；不代表视频延迟。`, `Last read-only parameter response (includes host HDC overhead), sampled at ${new Date(responseSample.sampledAt).toLocaleString()}; not video latency.`) : copy("尚无当前可核验的参数响应样本；不会显示旧值或估算延迟。", "No current verified parameter response; stale or estimated latency is not shown.")}>{responseSample ? copy(`响应 ${responseSample.durationMs} ms`, `Response ${responseSample.durationMs} ms`) : copy("响应未确认", "Response unconfirmed")}</span> : null}
        </div></div>
      </div>
      <div className={styles.toolbarActions}>
        <select aria-label={copy("投屏位置", "Mirror position")} value={mirror?.open ? mirror.presentation ?? mirrorPresentation : mirrorPresentation} onChange={event => {
          const value = event.target.value as "floating" | "sidebar"; setMirrorPresentation(value);
          if (mirror?.open) void window.piDesktop?.harmonyMirror?.setPresentation(value).catch(failure => setError(String(failure)));
        }}><option value="floating">{copy("独立悬浮窗", "Floating window")}</option><option value="sidebar">{copy("侧栏内显示", "Inside sidebar")}</option></select>
        <button className={styles.primaryButton} type="button" disabled={!selectedOnline} onClick={() => void openSelectedMirror()}>{copy("打开投屏", "Open mirror")}</button>
        <button type="button" disabled={!canScreenshot || Boolean(media.busy)} onClick={() => void mediaAction("capture_screenshot")} title={`${copy("截图", "Screenshot")}${screenshotShortcutLabel ? ` · ${screenshotShortcutLabel}` : ""}`}>{screenshotBusy ? copy("截图中…", "Capturing…") : copy("截图", "Screenshot")}</button>
        <button type="button" className={recording ? styles.recordingButton : undefined} aria-label={recording ? copy("停止录屏", "Stop recording") : copy("开始录屏", "Start recording")} disabled={!selectedOnline || Boolean(controlStatus) || media.transitioning || Boolean(window.piDesktop?.harmonyMirror && !mirror) || Boolean(recording && !ownsRecording)} onClick={() => void mediaAction(recording ? "stop_recording" : "start_recording")} title={copy("最长30分钟", "30 minute limit")}>{media.transitioning && media.busy !== "capture_screenshot" ? copy(recording?.phase === "saving" ? "保存中…" : "处理中…", "Working…") : recording ? `${copy("停止录屏", "Stop")} · ${formatRecordingElapsed(recordingElapsed)}` : copy("录屏", "Record")}</button>
        <div className={styles.secondaryActions}>
        {onMaximizedChange ? <button className={styles.focusButton} aria-label={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")} type="button" onClick={() => onMaximizedChange(!maximized)} title={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")}>
          <AliIcon name={maximized ? "fullscreen-exit" : "fullscreen"} size={16} />
        </button> : null}
        <button className={styles.iconButton} type="button" onClick={() => { void refresh(); }} disabled={busy} title={copy("刷新设备", "Refresh devices")} aria-label={copy("刷新设备", "Refresh devices")}><AliIcon name="reload" size={14} /></button>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen((open) => !open)} aria-pressed={settingsOpen} title={copy("设备设置", "Device settings")} aria-label={copy("设备设置", "Device settings")}><AliIcon name="setting" size={15} /></button>
        </div>
        <details className={styles.compactActions}><summary aria-label={copy("设备操作菜单", "Device actions")}>•••</summary><div>
        {onMaximizedChange ? <button className={styles.focusButton} aria-label={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")} type="button" onClick={() => onMaximizedChange(!maximized)} title={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")}>
          <AliIcon name={maximized ? "fullscreen-exit" : "fullscreen"} size={16} />
        </button> : null}
        <button className={styles.iconButton} type="button" onClick={() => { void refresh(); }} disabled={busy} title={copy("刷新设备", "Refresh devices")} aria-label={copy("刷新设备", "Refresh devices")}><AliIcon name="reload" size={14} /></button>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen((open) => !open)} aria-pressed={settingsOpen} title={copy("设备设置", "Device settings")} aria-label={copy("设备设置", "Device settings")}><AliIcon name="setting" size={15} /></button>
        </div></details>
      </div>
    </header>

    {settingsOpen ? <HarmonySettingsSurface onClose={() => setSettingsOpen(false)} title={copy("设备设置", "Device settings")}><section className={styles.settingsPanel} aria-label={copy("设备设置", "Device settings")}>
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
        <div className={styles.settingCopy}><strong>{copy("手动 Wi-Fi 连接", "Manual Wi-Fi connection")}</strong><small>{copy("通过 HDC 连接或断开局域网设备", "Connect or disconnect a LAN device through HDC")}</small></div>
        <TcpDeviceConnection chinese={chinese} onRefresh={() => refresh()} />
        {selected ? <p className={styles.inlineHint}>{selected.transport === "usb" ? copy("当前设备：USB（HDC 已标注）", "Current device: USB (reported by HDC)")
          : selected.transport === "tcp" ? selected.transportEvidence === "hdc" ? copy("当前设备：TCP/Wi-Fi（HDC 已标注）", "Current device: TCP/Wi-Fi (reported by HDC)")
            : copy("当前设备：TCP/Wi-Fi（根据 IP:端口序列号推断）", "Current device: TCP/Wi-Fi (inferred from IP:port serial)")
            : copy("当前设备的连接方式未知；HDC 未给出可核实的标记", "Connection type unknown; HDC did not provide a verifiable marker")}</p> : null}
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingCopy}><strong>{copy("投屏来源", "Video provider")}</strong><small>{copy("优先使用本机 DevEco 实时视频，无需打开手机共享页面；没有可用 SDK 时保留组件回退", "Prefer the installed DevEco live video service without opening the phone sharing app; retain the component fallback when no SDK is available")}</small></div>
        <select aria-label={copy("投屏来源", "Video provider")} value={videoProvider} onChange={event => setVideoProvider(event.target.value as "bundled" | "hos-scrcpy")}>
          <option value="bundled">{copy("自动（HDC 实时视频优先）", "Automatic (prefer HDC live video)")}</option><option value="hos-scrcpy">HOScrcpy</option>
        </select>
        {videoProvider === "hos-scrcpy" ? <>
          <label>{copy("本地 dsh-hos-scrcpy 包目录", "Local dsh-hos-scrcpy package directory")}<input value={hosPackageDirectory} onChange={event => setHosPackageDirectory(event.target.value)} /></label>
          <label>{copy("Java 可执行文件完整路径（留空使用 PATH）", "Full Java executable path (blank uses PATH)")}<input value={javaPath} onChange={event => setJavaPath(event.target.value)} /></label>
          <p className={styles.inlineHint}>{copy("需自行提供含 HOScrcpy SDK jar 和 Java sidecar 的本地包。Piora 只经已认证的设备视频接口转发画面，不向网页暴露 sidecar 地址；首次开流可能部署其设备组件。", "Supply a local package containing the HOScrcpy SDK jar and Java sidecar. Piora proxies video only through its authenticated device endpoint and does not expose the sidecar address to the browser; first capture may deploy its device component.")}</p>
        </> : null}
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
        </div>
        <p className={styles.inlineHint}>{copy("锁屏时请在手机上手动解锁。投屏不会自动唤醒或解锁。", "Unlock on the phone when needed. Mirroring never wakes or unlocks it.")}</p>
      </div>
      <div className={styles.settingsFooter}>
        <button type="button" onClick={() => setSettingsOpen(false)}>{copy("取消", "Cancel")}</button>
        <button className={styles.primaryButton} type="button" disabled={busy || (visionEnabled && !visionModelKey) || (videoProvider === "hos-scrcpy" && !hosPackageDirectory.trim())} onClick={saveSettings}>{copy("保存", "Save")}</button>
      </div>
      <HarmonyStorageSettings />
    </section></HarmonySettingsSurface> : null}

    <nav className={styles.workbenchTabs} role="tablist" aria-label={copy("设备功能", "Device functions")}>
      {(["overview", "apps", "files", "media", ...extraTabs] as Array<typeof toolTab>).map(tab => <div key={tab} className={styles.tabItem}>
        <button id={`${drawerId}-${tab}`} role="tab" aria-controls={drawerId} type="button" aria-selected={toolTab === tab} tabIndex={toolTab === tab ? 0 : -1} onKeyDown={event => {
          const tabs = ["overview", "apps", "files", "media", ...extraTabs] as Array<typeof toolTab>;
          const index = tabs.indexOf(tab);
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); changeToolTab(tabs[next]); document.getElementById(`${drawerId}-${tabs[next]}`)?.focus(); }
        }} onClick={() => changeToolTab(tab)}>{({ overview: copy("概览", "Overview"), apps: copy("应用", "Apps"), files: copy("文件", "Files"), media: copy("媒体", "Media"), databases: copy("数据库", "Databases"), commands: copy("终端", "Terminal"), logs: copy("日志", "Logs"), tree: copy("界面结构", "UI tree"), scenarios: copy("自动化", "Scenarios"), voice: copy("语音验证", "Voice"), diagnostics: copy("诊断", "Diagnostics"), inputs: copy("校准", "Calibration"), history: copy("任务", "Tasks") })[tab]}</button>
        {extraTabs.includes(tab) ? <button type="button" aria-label={copy("关闭功能标签", "Close tool tab")} onClick={() => { setExtraTabs(current => current.filter(item => item !== tab)); if (toolTab === tab) setToolTab("overview"); }}>×</button> : null}
      </div>)}
      <div className={styles.moreMenu}><button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>{copy("更多", "More")} ▾</button>
        {moreOpen ? <div className={styles.morePopover}>
          {([[copy("开发工具", "Development"), ["databases", "commands", "logs", "tree"]], [copy("自动化", "Automation"), ["scenarios", "voice"]], [copy("维护", "Maintenance"), ["diagnostics", "inputs"]]] as Array<[string, Array<typeof toolTab>]>).map(([label, tabs]) => <section key={label}><strong>{label}</strong>{tabs.map(tab => <button key={tab} type="button" onClick={() => changeToolTab(tab)}>{({ databases: copy("数据库", "Databases"), commands: copy("终端", "Terminal"), logs: copy("日志", "Logs"), tree: copy("界面结构", "UI tree"), scenarios: copy("自动化场景", "Scenarios"), voice: copy("语音验证", "Voice"), diagnostics: copy("诊断", "Diagnostics"), inputs: copy("校准", "Calibration") } as Record<string, string>)[tab]}</button>)}</section>)}
        </div> : null}
      </div>
      <button type="button" className={styles.tasksButton} onClick={() => changeToolTab("history")}>{copy("任务", "Tasks")}{tasksCount ? ` ${tasksCount}` : ""}</button>
      {lease || holder ? <button type="button" className={styles.stopButton} onClick={stopDevice} aria-label={copy("停止设备任务", "Stop device task")}>{copy("停止", "Stop")}</button> : null}
    </nav>
    {mirror?.open && mirror.presentation === "sidebar" ? <section className={styles.embeddedMirror} style={{ height: `calc(36px + ${65 * mirror.scale / 100}dvh)` }} aria-label={copy("侧栏投屏", "Sidebar mirror")}><MirrorWindow embedded serial={selectedSerial} active={active} onEnableVideo={() => void initializeMirror()} /></section> : null}
    <main className={styles.workbenchContent} data-tab={toolTab}>
      <div ref={drawerBodyRef} id={drawerId} role="tabpanel" aria-labelledby={`${drawerId}-${toolTab}`} className={styles.workbenchBody} aria-label={copy("工具内容", "Tool content")}>
        {toolTab === "overview" ? <section className={styles.overview}>
          <h2>{selected ? formatHarmonyDeviceLabel(selected) : copy("连接一台鸿蒙设备", "Connect a Harmony device")}</h2>
          <p>{selectedOnline ? copy("设备已连接。打开独立投屏，或使用顶部工具处理设备任务。", "Device connected. Open the mirror or choose a tool above.") : copy("通过 USB 连接手机并确认调试授权，也可以在设备设置中配置 Wi-Fi 连接。", "Connect by USB and allow debugging, or configure Wi-Fi in device settings.")}</p>
          <dl><dt>{copy("连接状态", "Status")}</dt><dd>{deviceStateLabel}</dd><dt>{copy("连接方式", "Transport")}</dt><dd>{connectionLabel}</dd><dt>{copy("系统", "System")}</dt><dd>{selected?.osVersion ?? copy("未获取", "Unavailable")}</dd><dt>{copy("序列号", "Serial")}</dt><dd>{selectedSerial || "—"}</dd></dl>
          <div className={styles.overviewActions}><button type="button" disabled={!selectedOnline} onClick={() => void openSelectedMirror()}>{copy("打开投屏", "Open mirror")}</button><button type="button" onClick={() => openTools("diagnostics")}>{copy("连接诊断", "Diagnostics")}</button><button type="button" onClick={() => setSettingsOpen(true)}>{copy("设备设置", "Device settings")}</button></div>
          {controlStatus ? <p>{copy("设备正在停止或恢复，请在诊断中核对状态。", "Device cleanup is pending. Check diagnostics.")}</p> : null}
        </section> : null}
        {recording?.systemRecorderStateUnknown && ownsRecording ? <section><p>{copy("手机系统录屏状态未确认。请在手机上停止后取回文件。", "System recording is unconfirmed. Stop it on the phone, then retrieve.")}</p><button type="button" disabled={Boolean(media.busy)} onClick={() => void mediaAction("retrieve_recording")}>{copy("我已停止，取回录屏", "I stopped it, retrieve recording")}</button></section> : null}
        {toolTab === "media" ? <>
          {recording?.phase === "save-failed" && ownsRecording ? <section><p>{copy("录屏草稿已保留，可重试保存，或在设备设置中更换保存目录。", "Recording draft retained. Retry saving or change the media directory in settings.")}</p><button disabled={Boolean(media.busy)} onClick={() => void mediaAction("retry_recording_save", recording.recordingId)}>{copy("重试保存", "Retry save")}</button></section> : null}
          {media.recoveries.map(draft => <section key={draft.recordingId}><p>{copy("未完成的录屏", "Unfinished recording")} · {new Date(draft.startedAt).toLocaleString()}</p>{draft.recoveryAvailable ? <button disabled={Boolean(media.busy)} onClick={() => void mediaAction("retry_recording_save", draft.recordingId)}>{draft.systemRecorderStateUnknown ? copy("我已在手机停止，取回文件", "Stopped on phone, retrieve") : copy("恢复并保存", "Recover and save")}</button> : <p>{copy("文件未完成封装，无法自动恢复；草稿仍保留。", "The file was not finalized and cannot be automatically recovered. Its draft is retained.")}</p>}<button disabled={Boolean(media.busy)} onClick={async () => {
            const answer = await showPioraMessage({ title: copy("放弃这个录屏草稿？", "Discard this recording draft?"), message: copy("将删除电脑上的恢复记录和临时文件，无法撤销。手机相册中的原文件会保留。", "Deletes the local recovery record and temporary file. This cannot be undone. Phone gallery originals remain."), tone: "confirm", actions: [{ id: "cancel", label: copy("保留", "Keep") }, { id: "discard", label: copy("放弃草稿", "Discard draft"), primary: true }] });
            if (answer === "discard") await mediaAction("discard_recording_draft", draft.recordingId);
          }}>{copy("放弃草稿", "Discard draft")}</button></section>)}
          <MediaHistory serial={selectedSerial} refreshKey={media.artifact?.filename} chinese={chinese} />
        </> : null}
          {toolsVisited ? <WorkbenchTools key={selectedSerial} geometryId={geometryId} tab={toolTab} serial={selectedSerial} active={active} chinese={chinese} canControl={canControl} ensureControl={ensureControl} onControlHandoff={clearControl} cwd={cwd} ownerId={ownerId} initialDatabaseId={databaseSelection} onOpenDatabase={id => { setDatabaseSelection(id); changeToolTab("databases"); }} onOpenFiles={() => changeToolTab("files")} onShowTasks={() => changeToolTab("history")} onOpenLocalTerminal={onOpenLocalTerminal} onCleanupConfirmed={async () => { setError(null); await refresh(); }} /> : null}
          {toolTab === "logs" ? <HarmonyLogViewer active={active} serial={selectedSerial} online={Boolean(selectedOnline)} copy={copy} /> : null}
          {toolTab === "diagnostics" || toolTab === "tree" ? <div className={styles.moreBody}>
            <button type="button" disabled={!canControl || busy} onClick={() => void initializeMirror()}>{copy("初始化投屏服务", "Initialize video service")}</button>
            <button type="button" disabled={!selectedOnline || busy} onClick={() => void openSelectedMirror()}>{copy("打开投屏", "Open mirror")}</button>
            <button type="button" disabled={!selectedOnline || busy || !selected?.capabilities.uiTree} onClick={() => void run(() => jsonRequest<{ snapshot: unknown }>(`/api/harmony/tree?serial=${encodeURIComponent(selectedSerial)}`), payload => setTree(payload.snapshot))}>{copy("读取界面结构", "Read interface structure")}</button>
            <details className={styles.diagnostics}><summary>{copy("开发者信息", "Developer details")}</summary><pre>{JSON.stringify({ selected, holder, snapshot, diagnostics, tree }, null, 2)}</pre></details>
            <button className={styles.stopButton} type="button" disabled={busy} onClick={() => { clearControl(); void run(() => jsonRequest("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "emergency_stop", reason: "desktop-global-stop" }) })); }}>{copy("停止所有设备操作", "Stop all devices")}</button>
          </div> : null}
        </div>
    </main>
    <PioraMessageHost />
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
