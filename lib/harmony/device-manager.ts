import { randomBytes } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { asHarmonyError, HarmonyError } from "./errors";
import { observationQuality, requireValidObservation } from "./observation/quality";
import { findHarmonyNodes, validateHarmonySelector } from "./selector";
import { resolveRetainedTarget } from "./observation/target-resolver";
import { fencedBackend } from "./runtime/dispatch-fence";
import { acquireDeviceLock } from "./runtime/device-lock";
import { capabilitiesFromHelp } from "./capabilities/probes";
import type { HarmonyDoctorReport } from "./contracts/capabilities";
import { ScenarioExecutionStore, observationFingerprint } from "./scenario/execution-store";
import { InputCalibrationStore, deviceFingerprint } from "./input/calibration-store";
import type { PhysicalKey } from "./input/key-catalog";
import { AudioAssetStore } from "./audio/audio-assets";
import { appTestPacket, type AppTestPairing } from "./audio/app-test-provider";
import { WindowsAcousticProvider } from "./audio/acoustic-provider";
import { runVoiceInput, validateVoiceProfile, VoiceProfileStore, type VoiceProfile } from "./audio/audio-session";
import { createSupportBundle, saveSupportBundle } from "./diagnostics/support-bundle";
import { HarmonyRecoveryStore } from "./runtime/recovery-store";
import { boundedCleanup } from "./runtime/resource-scope";
import { importHapArtifact } from "./runtime/hap-artifact";
import { importDeviceFileArtifact } from "./runtime/file-artifact";
import { transformFramePoint, type HarmonyGeometry } from "./observation/geometry";
import { videoMetadataTransform } from "./media/video-metadata";
import { createHybridHarmonyBackend } from "./hybrid-backend";
import { runHarmonyScenario, validateHarmonyScenario } from "./scenario-executor";
import {
  defaultHarmonyConfigPath,
  discoverHdcCandidates,
  readHarmonyConfig,
  writeHarmonyConfig,
} from "./runtime";
import type {
  BackendDevice,
  HarmonyAutomationBackend,
  HarmonyConfig,
  HarmonyDevice,
  HarmonyDiagnostics,
  HarmonyInputTextOptions,
  HarmonyDragOptions,
  HarmonyFlingOptions,
  HarmonyLogEntry,
  HarmonyLogOptions,
  HarmonyProcess,
  HarmonyLaunchAppOptions,
  HarmonyInstallAppOptions,
  HarmonyLease,
  HarmonyLeaseOwner,
  HarmonyManagerEvent,
  HarmonyManagerState,
  HarmonyMediaArtifact,
  HarmonyOperationResult,
  HarmonyPressKeyOptions,
  HarmonySnapshot,
  HarmonySnapshotOptions,
  HarmonyRecordingState,
  HarmonyScenarioOptions,
  HarmonyScenarioResult,
  HarmonyVideoConnection,
  HarmonySwipeOptions,
  HarmonyTapOptions,
  HarmonyPointGestureOptions,
  HarmonyTapRefOptions,
  HarmonyUiNode,
} from "./types";
import { prepareHarmonyRecordingPath, recordingArtifact, saveHarmonyScreenshot } from "./artifacts";

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 30 * 60_000;
const DEVICE_REFRESH_TTL_MS = 10_000;
const DEVICE_MISSING_GRACE_REFRESHES = 2;
// Keep a few lightweight semantic snapshots so an Agent can safely use a
// second ref from the same observation after another action or observer has
// advanced the current snapshot. Every retained target is re-read and
// uniquely matched against the live UiTest tree immediately before tapping.
const MAX_RETAINED_REFERENCE_SNAPSHOTS = 4;

export interface AcquireLeaseOptions {
  serial: string;
  owner: HarmonyLeaseOwner;
  ttlMs?: number;
  signal?: AbortSignal;
}

export interface HarmonyDeviceManagerOptions {
  arbitrationDirectory?: string;
  cleanupTimeoutMs?: number;
  backend?: HarmonyAutomationBackend;
  backendFactory?: (config: HarmonyConfig) => HarmonyAutomationBackend;
  configPath?: string;
  now?: () => number;
  token?: () => string;
}

type Listener = (event: HarmonyManagerEvent) => void;

interface StoredSnapshot extends HarmonySnapshot {
  nodeByRef: Map<string, HarmonyUiNode>;
}

interface StoredReferenceSnapshot {
  quality?: HarmonySnapshot["quality"];
  capturedAt: string;
  generation: number;
  revision: number;
  nodeByRef: Map<string, HarmonyUiNode>;
}

interface OperationLane {
  tail: Promise<void>;
  pending: number;
  active: boolean;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function awaitSharedOperation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony device discovery was cancelled", { retryable: true }));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HarmonyError("COMMAND_ABORTED", "Harmony device discovery was cancelled", { retryable: true }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function validateSerial(serial: string): void {
  if (typeof serial !== "string" || serial.length < 1 || serial.length > 256) {
    throw new HarmonyError("INVALID_ARGUMENT", "A valid device serial is required");
  }
}

function validateOwner(owner: HarmonyLeaseOwner): void {
  if (!owner || !["agent", "manual"].includes(owner.kind) || typeof owner.id !== "string" || !owner.id.trim()) {
    throw new HarmonyError("INVALID_ARGUMENT", "A valid lease owner is required");
  }
  if (owner.id.length > 512 || (owner.sessionId?.length ?? 0) > 512) {
    throw new HarmonyError("INVALID_ARGUMENT", "Lease owner identity is too long");
  }
}

export class HarmonyDeviceManager {
  private backend?: HarmonyAutomationBackend;
  private readonly injectedBackend: boolean;
  private readonly backendFactory: (config: HarmonyConfig) => HarmonyAutomationBackend;
  private readonly configPath: string;
  private config: HarmonyConfig;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly devices = new Map<string, HarmonyDevice>();
  private readonly generations = new Map<string, number>();
  private readonly presentLastRefresh = new Set<string>();
  private readonly missingRefreshCounts = new Map<string, number>();
  private readonly leasesBySerial = new Map<string, HarmonyLease>();
  private readonly leasesByToken = new Map<string, HarmonyLease>();
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly referenceSnapshots = new Map<string, StoredReferenceSnapshot[]>();
  private readonly recordings = new Map<string, HarmonyRecordingState>();
  private readonly liveFrameControllers = new Map<string, AbortController>();
  private readonly logStreamControllers = new Map<AbortController, string>();
  private readonly liveFramePromises = new Map<string, Promise<HarmonySnapshot>>();
  private readonly videoConnections = new Map<string, Set<HarmonyVideoConnection>>();
  private readonly liveFrameRevisions = new Map<string, number>();
  private readonly snapshotRevisions = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private runtimeError?: HarmonyError;
  private readonly operationLanes = new Map<string, OperationLane>();
  private pending = 0;
  private activeCount = 0;
  private queueEpoch = 0;
  private operationId = 0;
  private readonly activeControllers = new Set<AbortController>();
  private readonly controllersByOwner = new Map<string, Set<AbortController>>();
  private readonly controllersByLease = new Map<string, Set<AbortController>>();
  private readonly controllersByDevice = new Map<string, Set<AbortController>>();
  private readonly leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stoppingDevices = new Map<string, "stopping" | "recovering">();
  private readonly stopPromises = new Map<string, Promise<{ dispatchBlocked: true; cleanup: "complete" | "uncertain" }>>();
  private readonly recordingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recoveryStore?: HarmonyRecoveryStore;
  private readonly capabilityCache = new Map<string, { fingerprint: string; at: number; values: HarmonyDoctorReport["capabilities"] }>();
  private readonly capabilityFailures = new Map<string, Map<string, string>>();
  private readonly uncertainInput = new Set<string>();
  private readonly cleanupUnsettled = new Set<string>();
  private readonly cleanupWork = new Map<string, Promise<unknown>>();
  private readonly physicalLocks = new Map<string, ReturnType<typeof acquireDeviceLock>>();
  private readonly arbitrationDirectory?: string;
  private readonly cleanupTimeoutMs: number;
  private leaseEpoch = 0;
  private readonly scenarioStore?: ScenarioExecutionStore;
  private inputCalibration?: InputCalibrationStore;
  private audioAssets?: AudioAssetStore;
  private voiceProfiles?: VoiceProfileStore;
  private readonly acoustic = new WindowsAcousticProvider();
  private readonly frameDimensions = new Map<string, { width: number; height: number }>();
  private readonly frameCapturedAt = new Map<string, number>();
  private readonly geometries = new Map<string, HarmonyGeometry>();
  private stoppingAll = false;
  private disposed = false;
  private lastDeviceRefreshAt = Number.NEGATIVE_INFINITY;
  private deviceRefreshPromise?: Promise<HarmonyDevice[]>;
  private deviceRefreshController?: AbortController;

  constructor(options: HarmonyDeviceManagerOptions = {}) {
    this.arbitrationDirectory = options.arbitrationDirectory;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
    this.configPath = options.configPath ?? defaultHarmonyConfigPath();
    this.config = readHarmonyConfig(this.configPath);
    this.now = options.now ?? Date.now;
    if (!options.backend || options.configPath) {
      this.scenarioStore = new ScenarioExecutionStore(join(dirname(this.configPath), "harmony-executions"));
      this.scenarioStore.recoverInterrupted();
      this.recoveryStore = new HarmonyRecoveryStore(join(dirname(this.configPath), "harmony-recovery"));
      for (const record of this.recoveryStore.interrupted()) {
        // An owned recording is a local stream subscription, not phone input.
        // The exited process cannot keep recording; exact forward evidence stays
        // in the backend journal. Only physical input needs release confirmation.
        const resources = record.resources ?? { [record.kind]: record.state };
        this.recoveryStore.clear(record.serial, "recording");
        if (resources.input) { this.uncertainInput.add(record.serial); this.stoppingDevices.set(record.serial, "recovering"); }
      }
    }
    this.token = options.token ?? (() => randomBytes(24).toString("base64url"));
    this.backendFactory = options.backendFactory ?? ((config) => createHybridHarmonyBackend({ resolve: { config } }));
    this.injectedBackend = Boolean(options.backend);
    this.backend = options.backend;
    if (!this.backend) this.tryCreateBackend();
  }

  private tryCreateBackend(): void {
    try {
      this.backend = this.backendFactory(this.config);
      this.runtimeError = undefined;
    } catch (error) {
      this.backend = undefined;
      this.runtimeError = asHarmonyError(error);
    }
  }

  private requireBackend(): HarmonyAutomationBackend {
    if (this.disposed) throw new HarmonyError("INTERNAL_ERROR", "Harmony device manager is disposed");
    if (!this.backend) throw this.runtimeError ?? new HarmonyError("HDC_NOT_FOUND", "HDC is unavailable");
    return this.backend;
  }

  private emit(event: HarmonyManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* A broken SSE client must not break device control. */ }
    }
  }

  private forgetDeviceSnapshots(serial: string): void {
    this.snapshots.delete(serial);
    this.referenceSnapshots.delete(serial);
    this.geometries.delete(`${serial}:video`);
    this.geometries.delete(`${serial}:screenshot`);
  }

  private retainSnapshotReferences(serial: string, snapshot: StoredSnapshot): void {
    const history = (this.referenceSnapshots.get(serial) ?? [])
      .filter((entry) => entry.generation === snapshot.generation && entry.revision !== snapshot.revision);
    history.push({
      capturedAt: snapshot.capturedAt,
      quality: snapshot.quality,
      generation: snapshot.generation,
      revision: snapshot.revision,
      nodeByRef: snapshot.nodeByRef,
    });
    if (history.length > MAX_RETAINED_REFERENCE_SNAPSHOTS) {
      history.splice(0, history.length - MAX_RETAINED_REFERENCE_SNAPSHOTS);
    }
    this.referenceSnapshots.set(serial, history);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private withAbort(parent?: AbortSignal, ownerId?: string, serial?: string, leaseToken?: string): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) controller.abort(parent.reason);
    else parent?.addEventListener("abort", abort, { once: true });
    this.activeControllers.add(controller);
    const indexes: Array<[Map<string, Set<AbortController>>, string | undefined]> = [
      [this.controllersByDevice, serial], [this.controllersByLease, leaseToken],
    ];
    for (const [index, key] of indexes) {
      if (!key) continue;
      const controllers = index.get(key) ?? new Set<AbortController>();
      controllers.add(controller);
      index.set(key, controllers);
    }
    if (ownerId) {
      const owned = this.controllersByOwner.get(ownerId) ?? new Set<AbortController>();
      owned.add(controller);
      this.controllersByOwner.set(ownerId, owned);
    }
    return {
      controller,
      cleanup: () => {
        parent?.removeEventListener("abort", abort);
        this.activeControllers.delete(controller);
        for (const [index, key] of indexes) {
          if (!key) continue;
          const controllers = index.get(key);
          controllers?.delete(controller);
          if (!controllers?.size) index.delete(key);
        }
        if (ownerId) {
          const owned = this.controllersByOwner.get(ownerId);
          owned?.delete(controller);
          if (owned?.size === 0) this.controllersByOwner.delete(ownerId);
        }
      },
    };
  }

  private enqueue<T>(
    operation: string,
    task: (signal: AbortSignal, operationId: number) => Promise<T>,
    parentSignal?: AbortSignal,
    ownerId?: string,
    serial?: string,
    leaseToken?: string,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new HarmonyError("INTERNAL_ERROR", "Harmony device manager is disposed"));
    const epoch = this.queueEpoch;
    const operationId = ++this.operationId;
    const abort = this.withAbort(parentSignal, ownerId, serial, leaseToken);
    const laneKey = serial ? `device:${serial}` : "global";
    const lane = this.operationLanes.get(laneKey) ?? { tail: Promise.resolve(), pending: 0, active: false };
    if (lane.pending >= 64) {
      abort.cleanup();
      return Promise.reject(new HarmonyError("DEVICE_BUSY", "Device queue is full; wait for pending work to complete", { retryable: true }));
    }
    this.operationLanes.set(laneKey, lane);
    this.pending += 1;
    lane.pending += 1;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });

    lane.tail = lane.tail
      .catch(() => undefined)
      .then(async () => {
        this.pending -= 1;
        lane.pending -= 1;
        if (epoch !== this.queueEpoch || abort.controller.signal.aborted) {
          abort.cleanup();
          if (lane.pending === 0 && !lane.active) this.operationLanes.delete(laneKey);
          rejectResult(new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled by emergency stop", { retryable: true }));
          return;
        }
        lane.active = true;
        this.activeCount += 1;
        try {
          const value = await task(abort.controller.signal, operationId);
          resolveResult(value);
        } catch (error) {
          rejectResult(asHarmonyError(error));
        } finally {
          abort.cleanup();
          lane.active = false;
          this.activeCount -= 1;
          if (lane.pending === 0 && !lane.active) this.operationLanes.delete(laneKey);
        }
      });
    return result;
  }

  private sweepExpiredLeases(): void {
    const now = this.now();
    for (const lease of [...this.leasesByToken.values()]) {
      if (Date.parse(lease.expiresAt) <= now) this.removeLease(lease, "expired");
    }
  }

  private scheduleLeaseExpiry(lease: HarmonyLease): void {
    clearTimeout(this.leaseTimers.get(lease.token));
    const timer = setTimeout(() => {
      const current = this.leasesByToken.get(lease.token);
      if (!current) return;
      if (Date.parse(current.expiresAt) <= this.now()) this.removeLease(current, "expired");
      else this.scheduleLeaseExpiry(current);
    }, Math.max(1, Date.parse(lease.expiresAt) - this.now()));
    timer.unref?.();
    this.leaseTimers.set(lease.token, timer);
  }

  private requireAdmission(serial: string): void {
    if (this.stoppingAll || this.stoppingDevices.has(serial)) {
      throw new HarmonyError("DEVICE_BUSY", "Device dispatch is blocked while stopping or awaiting cleanup confirmation", {
        details: { state: this.stoppingDevices.get(serial) ?? "stopping", dispatchState: "not-sent" },
      });
    }
  }

  private removeLease(lease: HarmonyLease, reason: string): void {
    clearTimeout(this.leaseTimers.get(lease.token));
    this.leaseTimers.delete(lease.token);
    this.leasesByToken.delete(lease.token);
    if (this.leasesBySerial.get(lease.serial)?.token === lease.token) this.leasesBySerial.delete(lease.serial);
    this.forgetDeviceSnapshots(lease.serial);
    for (const controller of this.controllersByLease.get(lease.token) ?? []) controller.abort(reason);
    this.emit({
      type: "lease_released",
      timestamp: iso(this.now()),
      serial: lease.serial,
      ownerId: lease.owner.id,
      reason,
    });
    if (!this.stoppingDevices.has(lease.serial) && (this.physicalLocks.has(lease.serial) || this.recordings.has(lease.serial) || this.controllersByLease.get(lease.token)?.size)) {
      void this.stopDevice(lease.serial, reason);
    }
  }

  private requireLease(serial: string, token: string | undefined): HarmonyLease {
    this.requireAdmission(serial);
    this.sweepExpiredLeases();
    if (!token) throw new HarmonyError("LEASE_REQUIRED", "An active device lease is required");
    const lease = this.leasesByToken.get(token);
    if (!lease || lease.serial !== serial) {
      throw new HarmonyError("LEASE_REQUIRED", "The device lease is missing or belongs to another device");
    }
    if (lease.deviceEpoch !== this.generations.get(serial)) {
      this.removeLease(lease, "device_epoch_changed");
      throw new HarmonyError("LEASE_EXPIRED", "The device connection changed; acquire fresh control");
    }
    if (Date.parse(lease.expiresAt) <= this.now()) {
      this.removeLease(lease, "expired");
      throw new HarmonyError("LEASE_EXPIRED", "The device lease has expired", { retryable: true });
    }
    return lease;
  }

  private controlBackend(serial: string, token: string, signal: AbortSignal): HarmonyAutomationBackend {
    return fencedBackend(this.requireBackend(), signal, () => { this.requireLease(serial, token); }, async (method, args) => {
      this.requireLease(serial, token);
      if (method === "installPackage") {
        args[1] = await importHapArtifact(String(args[1]), join(dirname(this.configPath), "harmony-artifacts"));
      }
      if (method === "pushFile") {
        args[2] = await importDeviceFileArtifact(String(args[2]), join(dirname(this.configPath), "harmony-file-artifacts"));
      }
      return args;
    }, (method, args, error) => {
      const failure = asHarmonyError(error);
      if (!["CAPABILITY_UNAVAILABLE", "COMMAND_FAILED", "AUTOMATION_DRIVER_FAILED", "AUTOMATION_DRIVER_UNAVAILABLE"].includes(failure.code)) return;
      const names: Record<string, string> = { doubleTap: "double_tap", longPress: "long_press", pressKey: "press_key", keyHold: "key_hold", touchHold: "touch_hold", inputText: "input_text", launchApp: "launch_app" };
      const action = method === "semanticAction" ? String((args[1] as { action?: string })?.action) : names[method] ?? method;
      const failures = this.capabilityFailures.get(serial) ?? new Map<string, string>();
      failures.set(action, failure.code); this.capabilityFailures.set(serial, failures);
    });
  }

  private duration(ttlMs?: number): number {
    const value = ttlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isFinite(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
      throw new HarmonyError("INVALID_ARGUMENT", `Lease TTL must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms`);
    }
    return Math.round(value);
  }

  private normalizeDevices(devices: BackendDevice[]): HarmonyDevice[] {
    const timestamp = iso(this.now());
    const presentNow = new Set<string>();
    const normalized: HarmonyDevice[] = [];
    for (const device of devices) {
      validateSerial(device.serial);
      if (presentNow.has(device.serial)) continue;
      presentNow.add(device.serial);
      this.missingRefreshCounts.delete(device.serial);
      const previous = this.devices.get(device.serial);
      const wasPresent = this.presentLastRefresh.has(device.serial);
      let generation = this.generations.get(device.serial) ?? 0;
      if (generation === 0) generation = 1;
      else if (!wasPresent || previous?.state !== device.state) generation += 1;
      this.generations.set(device.serial, generation);
      const current: HarmonyDevice = { ...device, generation, lastSeenAt: timestamp };
      this.devices.set(device.serial, current);
      normalized.push(current);
      if (!previous || previous.generation !== generation || deviceFingerprint(previous) !== deviceFingerprint(current)) { this.forgetDeviceSnapshots(device.serial); this.capabilityCache.delete(device.serial); this.capabilityFailures.delete(device.serial); }
      if (current.state !== "online") {
        const lease = this.leasesBySerial.get(device.serial);
        if (lease) this.removeLease(lease, "device_offline");
      }
    }
    for (const serial of [...this.presentLastRefresh]) {
      if (!presentNow.has(serial)) {
        const missingRefreshes = (this.missingRefreshCounts.get(serial) ?? 0) + 1;
        if (missingRefreshes <= DEVICE_MISSING_GRACE_REFRESHES) {
          this.missingRefreshCounts.set(serial, missingRefreshes);
          const previous = this.devices.get(serial);
          if (previous) normalized.push(previous);
          continue;
        }
        this.missingRefreshCounts.delete(serial);
        this.presentLastRefresh.delete(serial);
        this.devices.delete(serial);
        this.forgetDeviceSnapshots(serial);
        const lease = this.leasesBySerial.get(serial);
        if (lease) this.removeLease(lease, "device_disconnected");
      }
    }
    for (const serial of presentNow) this.presentLastRefresh.add(serial);
    return normalized;
  }

  private async refreshDevices(signal?: AbortSignal): Promise<HarmonyDevice[]> {
    if (this.deviceRefreshPromise) return await awaitSharedOperation(this.deviceRefreshPromise, signal);
    const backend = this.requireBackend();
    const controller = new AbortController();
    this.deviceRefreshController = controller;
    const refresh = (async () => {
      try {
        const devices = this.normalizeDevices(await backend.listDevices(controller.signal));
        this.lastDeviceRefreshAt = this.now();
        this.runtimeError = undefined;
        this.emit({ type: "devices", timestamp: iso(this.now()), devices });
        return devices;
      } catch (error) {
        this.runtimeError = asHarmonyError(error);
        throw this.runtimeError;
      }
    })();
    this.deviceRefreshPromise = refresh;
    void refresh.finally(() => {
      if (this.deviceRefreshPromise === refresh) {
        this.deviceRefreshPromise = undefined;
        this.deviceRefreshController = undefined;
      }
    }).catch(() => undefined);
    return await awaitSharedOperation(refresh, signal);
  }

  async listDevices(signal?: AbortSignal): Promise<HarmonyDevice[]> {
    return await this.enqueue("list_devices", async (queuedSignal) => await this.refreshDevices(queuedSignal), signal);
  }

  async listProcesses(serial: string, signal?: AbortSignal): Promise<HarmonyProcess[]> {
    validateSerial(serial);
    return await this.enqueue("list_processes", async (queuedSignal) => {
      await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.listProcesses) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony process discovery is unavailable");
      return await backend.listProcesses(serial, queuedSignal);
    }, signal, undefined, serial);
  }

  async applications(serial: string, query?: string, bundleName?: string, signal?: AbortSignal) {
    validateSerial(serial);
    return this.enqueue("applications", async queuedSignal => {
      await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.applications) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Application discovery is unavailable");
      return backend.applications(serial, query, bundleName, queuedSignal);
    }, signal, undefined, serial);
  }

  async listFiles(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    validateSerial(serial);
    return await this.enqueue("list_device_files", async queuedSignal => {
      await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.listFiles) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device file browsing is unavailable");
      return await backend.listFiles(serial, scope, path, queuedSignal);
    }, signal, undefined, serial);
  }

  async pullFile(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, destinationPath: string, signal?: AbortSignal) {
    validateSerial(serial);
    return await this.enqueue("pull_device_file", async queuedSignal => {
      await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.pullFile) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device file download is unavailable");
      return await backend.pullFile(serial, scope, path, destinationPath, queuedSignal);
    }, signal, undefined, serial);
  }

  async uploadFile(options: { serial: string; leaseToken: string; scope: import("./device-files").HarmonyFileScope; sourcePath: string; path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("upload_file", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.pushFile) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device file upload is unavailable");
        await backend.pushFile(options.serial, options.scope, options.sourcePath, options.path, options.overwrite ?? false, signal);
      });
  }

  async createDirectory(options: { serial: string; leaseToken: string; scope: import("./device-files").HarmonyFileScope; path: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("create_directory", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.createDirectory) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device directory creation is unavailable");
        await backend.createDirectory(options.serial, options.scope, options.path, signal);
      });
  }

  async deletePath(options: { serial: string; leaseToken: string; scope: import("./device-files").HarmonyFileScope; path: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("delete_path", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.deletePath) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device file deletion is unavailable");
        await backend.deletePath(options.serial, options.scope, options.path, signal);
      });
  }

  async renamePath(options: { serial: string; leaseToken: string; scope: import("./device-files").HarmonyFileScope; path: string; newPath: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("rename_path", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.renamePath) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device file rename is unavailable");
        await backend.renamePath(options.serial, options.scope, options.path, options.newPath, signal);
      });
  }

  async readTextFile(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    validateSerial(serial);
    return await this.enqueue("read_device_text", async queuedSignal => {
      await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.readTextFile) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device text preview is unavailable");
      return await backend.readTextFile(serial, scope, path, queuedSignal);
    }, signal, undefined, serial);
  }

  async saveTextFile(options: { serial: string; leaseToken: string; scope: import("./device-files").HarmonyFileScope; path: string; text: string; expectedHash: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    const result = await this.action("save_text_file", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.saveTextFile) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device text editing is unavailable");
        await backend.saveTextFile(options.serial, options.scope, options.path, options.text, options.expectedHash, signal);
      });
    if (result.receipt) { result.receipt.effect = "applied"; result.receipt.verification = "passed"; }
    return result;
  }

  async readLogs(options: HarmonyLogOptions): Promise<HarmonyLogEntry[]> {
    validateSerial(options.serial);
    return await this.enqueue("read_logs", async (queuedSignal) => {
      await this.onlineDevice(options.serial, queuedSignal);
      const backend = this.requireBackend();
      if (!backend.readLogs) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony device logs are unavailable");
      return await backend.readLogs(options.serial, {
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
        ...(options.level ? { level: options.level } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        signal: queuedSignal,
      });
    }, options.signal, undefined, options.serial);
  }

  async streamLogs(serial: string, onEntries: (entries: HarmonyLogEntry[]) => void, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    const backend = await this.enqueue("start_log_stream", async (queuedSignal) => {
      await this.onlineDevice(serial, queuedSignal);
      return this.requireBackend();
    }, signal, undefined, serial);
    if (!backend.streamLogs) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "设备不支持实时日志");
    // The live read must not occupy the physical-device command queue.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || this.disposed) controller.abort();
    this.logStreamControllers.set(controller, serial);
    try { await backend.streamLogs(serial, onEntries, controller.signal); }
    finally { signal?.removeEventListener("abort", abort); this.logStreamControllers.delete(controller); }
  }

  private async onlineDevice(serial: string, signal?: AbortSignal): Promise<HarmonyDevice> {
    const cached = this.devices.get(serial);
    const device = cached?.state === "online" && this.now() - this.lastDeviceRefreshAt < DEVICE_REFRESH_TTL_MS
      ? cached
      : (await this.refreshDevices(signal)).find((candidate) => candidate.serial === serial);
    if (!device) throw new HarmonyError("DEVICE_NOT_FOUND", "Harmony device is not connected", { retryable: true });
    if (device.state !== "online") throw new HarmonyError("DEVICE_OFFLINE", "Harmony device is not online or authorized", { retryable: true });
    return device;
  }

  async doctor(serial: string, signal?: AbortSignal, reprobe = false): Promise<HarmonyDoctorReport> {
    validateSerial(serial);
    return await this.enqueue("doctor", async queuedSignal => {
      if (!this.backend && !this.injectedBackend && reprobe) this.tryCreateBackend();
      const device = await this.onlineDevice(serial, queuedSignal);
      const backend = this.requireBackend();
      const versions: HarmonyDoctorReport["versions"] = { os: device.osVersion, api: device.apiVersion, uitest: device.uitestVersion };
      let hdcStamp = "unknown";
      try { const info = statSync(backend.hdcPath!); hdcStamp = `${info.size}:${info.mtimeMs}`; } catch { /* Missing or injected executable. */ }
      try { versions.hypium = JSON.parse(readFileSync(join(process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd(), "node_modules", "hypium-driver", "package.json"), "utf8")).version; } catch { /* Unknown installed driver. */ }
      const fingerprint = `${deviceFingerprint(device)}:${device.generation}:${device.uitestVersion}:${backend.hdcPath}:${hdcStamp}:${versions.hypium}`;
      const cached = this.capabilityCache.get(serial);
      if (reprobe) this.capabilityFailures.delete(serial);
      let capabilities: HarmonyDoctorReport["capabilities"];
      if (!reprobe && cached?.fingerprint === fingerprint && this.now() - cached.at < 300_000) capabilities = cached.values;
      else {
        capabilities = backend.probeCapabilities ? await backend.probeCapabilities(serial, queuedSignal) : capabilitiesFromHelp({});
        this.capabilityCache.set(serial, { fingerprint, at: this.now(), values: capabilities });
      }
      capabilities = capabilities.map(capability => this.capabilityFailures.get(serial)?.has(capability.action)
        ? { ...capability, status: "unavailable", reason: `A real dispatch failed (${this.capabilityFailures.get(serial)!.get(capability.action)}); use Check device to explicitly reprobe`, evidence: "probed" } : capability);
      const checks: HarmonyDoctorReport["checks"] = [{ name: "connection", status: "passed" }];
      try {
        if (!backend.displayGeometry) throw new Error("Provider has no native geometry probe");
        await backend.displayGeometry(serial, queuedSignal);
        checks.push({ name: "native-geometry", status: "passed" });
      } catch { checks.push({ name: "native-geometry", status: "unknown", reason: "Coordinate control requires a known display and a fresh frame" }); }
      const probe = await backend.doctorProbes?.(serial, queuedSignal);
      if (probe) { versions.hdc = probe.hdcVersion; checks.push(...probe.checks); }
      try {
        const observation = await backend.snapshot(serial, { includeTree: true, includeScreenshot: false, signal: queuedSignal });
        requireValidObservation(observation); checks.push({ name: "ui-tree", status: "passed", reason: "Current scoped tree parsed successfully; contents are not included in doctor" });
      } catch { checks.push({ name: "ui-tree", status: "unknown", reason: "Cannot verify the current window tree; inspect device authorization and foreground test app" }); }
      if (!this.injectedBackend) {
        try {
          const { inspectHarmonyCheckEnvironment } = await import("./check-runtime");
          const environment = inspectHarmonyCheckEnvironment();
          versions.deveco = environment.studioVersion; versions.devecoCli = environment.cliVersion;
          checks.push({ name: "deveco-cli", status: environment.ready ? "passed" : "unknown", reason: environment.ready ? "Installed toolchain detected; project ArkTS/lint checks remain separate" : "Configure DevEco Studio under Harmony development settings" });
        } catch { checks.push({ name: "deveco-cli", status: "unknown", reason: "Local development toolchain could not be inspected" }); }
        const candidates = discoverHdcCandidates({ config: this.config });
        checks.push({ name: "hdc-selection", status: "passed", reason: `Selected: ${backend.hdcPath}; ${candidates.length} local candidate(s). A runtime switch requires an explicit selection.` });
        try { const outputs = await this.acoustic.outputs(queuedSignal); checks.push({ name: "acoustic-routes", status: outputs.length ? "passed" : "unknown", reason: `${outputs.length} output(s); ${this.voiceStore().listIds(device).length} device-bound calibrated profile(s). No sound was played.` }); }
        catch { checks.push({ name: "acoustic-routes", status: "unknown", reason: "Output enumeration unavailable; choose and calibrate an explicit supported route" }); }
      }
      const automation = backend.automationDiagnostics?.();
      const worker = automation?.sessions?.find(session => session.serial === serial);
      checks.push({ name: "hypium-worker", status: worker?.state === "ready" ? "passed" : "unknown", reason: worker ? `Worker state: ${worker.state}` : "No live worker has verified this device; doctor does not initialize a control session" });
      const forwards = backend.interruptedForwards?.(serial) ?? [];
      if (forwards.length) checks.push({ name: "orphaned-video-forwards", status: "unknown", reason: `Prior process exited; manually inspect only these recorded local ports: ${forwards.map(forward => forward.localPort).join(", ")}. No automatic removal.` });
      if (queuedSignal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Doctor cancelled");
      return { serial, deviceEpoch: device.generation, checkedAt: iso(this.now()),
        versions,
        capabilities: capabilities.map(capability => ({ ...capability, deviceEpoch: device.generation })), checks,
        nextActions: checks.some(check => check.status !== "passed") ? ["Inspect the phone's display configuration; unlock it manually if needed. No automatic unlock is performed."] : [],
      };
    }, signal, undefined, serial);
  }

  async acquireLease(options: AcquireLeaseOptions): Promise<HarmonyLease> {
    this.requireAdmission(options.serial);
    validateSerial(options.serial);
    validateOwner(options.owner);
    const ttl = this.duration(options.ttlMs);
    return await this.enqueue("acquire_lease", async (signal) => {
      const device = await this.onlineDevice(options.serial, signal);
      this.requireAdmission(options.serial);
      if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device lease acquisition was cancelled", { retryable: true });
      this.sweepExpiredLeases();
      const existing = this.leasesBySerial.get(options.serial);
      if (existing) {
        if (existing.owner.id !== options.owner.id) {
          throw new HarmonyError("LEASE_CONFLICT", "The device is controlled by another owner", {
            details: { ownerKind: existing.owner.kind, expiresAt: existing.expiresAt },
            retryable: true,
          });
        }
        const renewed: HarmonyLease = { ...existing, expiresAt: iso(this.now() + ttl) };
        this.leasesBySerial.set(options.serial, renewed);
        this.leasesByToken.set(renewed.token, renewed);
        this.scheduleLeaseExpiry(renewed);
        return renewed;
      }
      const acquiredAt = iso(this.now());
      if ((!this.injectedBackend || this.arbitrationDirectory) && !this.physicalLocks.has(options.serial)) {
        this.physicalLocks.set(options.serial, acquireDeviceLock(options.serial, this.arbitrationDirectory));
      }
      const lease: HarmonyLease = {
        deviceEpoch: device.generation,
        leaseEpoch: ++this.leaseEpoch,
        token: this.token(),
        serial: options.serial,
        owner: { ...options.owner },
        acquiredAt,
        expiresAt: iso(this.now() + ttl),
      };
      this.leasesBySerial.set(options.serial, lease);
      this.leasesByToken.set(lease.token, lease);
      this.scheduleLeaseExpiry(lease);
      this.emit({ type: "lease_acquired", timestamp: acquiredAt, lease });
      return lease;
    }, options.signal, options.owner.id, options.serial);
  }

  renewLease(token: string, ttlMs?: number): HarmonyLease {
    this.sweepExpiredLeases();
    const lease = this.leasesByToken.get(token);
    if (!lease) throw new HarmonyError("LEASE_EXPIRED", "The device lease is missing or expired", { retryable: true });
    this.requireLease(lease.serial, token);
    const renewed = { ...lease, expiresAt: iso(this.now() + this.duration(ttlMs)) };
    this.leasesByToken.set(token, renewed);
    this.leasesBySerial.set(lease.serial, renewed);
    this.scheduleLeaseExpiry(renewed);
    return renewed;
  }

  releaseLease(token: string): boolean {
    const lease = this.leasesByToken.get(token);
    if (!lease) return false;
    this.removeLease(lease, "released");
    if (this.physicalLocks.has(lease.serial) || this.recordings.has(lease.serial)) void this.stopDevice(lease.serial, "released");
    return true;
  }

  releaseOwner(ownerId: string): number {
    let count = 0;
    for (const lease of [...this.leasesByToken.values()]) {
      if (lease.owner.id === ownerId) {
        this.releaseLease(lease.token);
        count += 1;
      }
    }
    for (const controller of this.controllersByOwner.get(ownerId) ?? []) controller.abort("owner_released");
    return count;
  }

  private async captureSnapshotNow(
    serial: string,
    includeTree: boolean,
    includeScreenshot: boolean,
    signal?: AbortSignal,
  ): Promise<HarmonySnapshot> {
      const device = await this.onlineDevice(serial, signal);
      const raw = await this.requireBackend().snapshot(serial, { includeTree, includeScreenshot, signal });
      if (raw.screenshot?.width && raw.screenshot.height) this.recordFrameDimensions(serial, "screenshot", raw.screenshot.width, raw.screenshot.height);
      const revision = (this.snapshotRevisions.get(serial) ?? 0) + 1;
      this.snapshotRevisions.set(serial, revision);
      const nodes: HarmonyUiNode[] | undefined = includeTree ? raw.nodes?.map((node, index, all) => ({
        ...node,
        ref: `g${device.generation}-r${revision}-n${index}`,
        ...(node.parentIndex === undefined
          ? {}
          : { parentRef: `g${device.generation}-r${revision}-n${Math.min(node.parentIndex, all.length - 1)}` }),
        parentIndex: undefined,
      })) : undefined;
      const snapshot: StoredSnapshot = {
        serial,
        generation: device.generation,
        revision,
        capturedAt: iso(this.now()),
        quality: includeTree ? observationQuality(raw) : { treeStatus: "unavailable", scopeComplete: false, scope: "unknown" },
        tree: includeTree ? raw.tree : undefined,
        nodes,
        screenshot: includeScreenshot ? raw.screenshot : undefined,
        nodeByRef: new Map((nodes ?? []).map((node) => [node.ref, node])),
      };
      // Live-view screenshot polling must not replace the latest UI-tree refs.
      // A later tree capture becomes the public current snapshot; a bounded
      // semantic history keeps older refs recoverable through live revalidation.
      if (includeTree) {
        this.snapshots.set(serial, snapshot);
        this.retainSnapshotReferences(serial, snapshot);
      }
      this.emit({ type: "snapshot", timestamp: snapshot.capturedAt, serial, generation: device.generation, revision });
      const { nodeByRef, ...publicSnapshot } = snapshot;
      void nodeByRef;
      return publicSnapshot;
  }

  async snapshot(options: HarmonySnapshotOptions): Promise<HarmonySnapshot> {
    validateSerial(options.serial);
    const includeTree = options.includeTree ?? true;
    const includeScreenshot = options.includeScreenshot ?? true;
    if (includeTree) await this.interruptLiveFrame(options.serial, "semantic_snapshot");
    return await this.enqueue("snapshot", async (signal) => {
      if (options.leaseToken) this.requireLease(options.serial, options.leaseToken);
      return await this.captureSnapshotNow(options.serial, includeTree, includeScreenshot, signal);
    }, options.signal, undefined, options.serial);
  }

  async runScenario(options: HarmonyScenarioOptions): Promise<HarmonyScenarioResult> {
    return this.runScenarioInternal(options);
  }

  private async runScenarioInternal(options: HarmonyScenarioOptions, resumeId?: string): Promise<HarmonyScenarioResult> {
    validateSerial(options.serial);
    const lease = this.requireLease(options.serial, options.leaseToken);
    await this.interruptLiveFrame(options.serial, "run_scenario");
    return await this.enqueue("run_scenario", async (signal, operationId) => {
      this.requireLease(options.serial, options.leaseToken);
      const device = await this.onlineDevice(options.serial, signal);
      if (resumeId) {
        if (!this.scenarioStore) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Scenario journal is unavailable");
        const snapshot = await this.captureSnapshotNow(options.serial, true, false, signal);
        options = { ...options, ...this.scenarioStore.resumeInputs(resumeId, snapshot, lease.owner.sessionId, deviceFingerprint(device)) };
      }
      validateHarmonyScenario(options);
      const execution = this.scenarioStore?.create(options, lease.owner, device.generation, resumeId, deviceFingerprint(device));
      try {
      const result = await runHarmonyScenario({ ...options, signal }, {
        serial: options.serial,
        generation: device.generation,
        leaseEpoch: lease.leaseEpoch,
        backend: this.controlBackend(options.serial, options.leaseToken, signal),
        signal,
        now: this.now,
        capture: async (captureOptions, captureSignal) => await this.captureSnapshotNow(
          options.serial,
          captureOptions.includeTree,
          captureOptions.includeScreenshot,
          captureSignal ?? signal,
        ),
        compound: async (step, stepSignal) => {
          if (step.action === "voice_input") {
            await this.withInputRecovery(options.serial, lease, () => this.executeVoice({ ...step, serial: options.serial, leaseToken: options.leaseToken }, this.controlBackend(options.serial, options.leaseToken, stepSignal), stepSignal));
            return "device_transcript_verified";
          }
          if (step.action === "geometry_assert") {
            await this.captureSnapshotNow(options.serial, false, true, stepSignal);
            const geometry = await this.getFrameGeometry(options.serial, "screenshot", stepSignal);
            if (geometry.displayRotation !== step.rotation) throw new HarmonyError("SCENARIO_FAILED", "Observed display rotation differs from the expected orientation", { details: { dispatchState: "not-sent", expected: step.rotation, actual: geometry.displayRotation } });
            return "native_geometry_verified";
          }
          throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Compound action is unavailable");
        },
        invalidateSnapshot: () => this.snapshots.delete(options.serial),
        beforeStep: () => {
          this.requireLease(options.serial, options.leaseToken);
        },
        onStep: (step, checkpoint) => {
          this.emit({ type: "operation", timestamp: iso(this.now()), serial: options.serial, operation: `scenario_step_${step.index}_${step.status}`, operationId });
          if (!execution || !this.scenarioStore) return;
          execution.steps[step.index] = step;
          if (checkpoint) execution.checkpoint = { name: checkpoint.name, stepIndex: checkpoint.stepIndex, observationHash: observationFingerprint(checkpoint.snapshot) };
          this.scenarioStore.write(execution);
        },
      });
      if (execution && this.scenarioStore) { this.scenarioStore.finish(execution, result); result.executionId = execution.id; }
      this.emit({
        type: "operation",
        timestamp: iso(this.now()),
        serial: options.serial,
        operation: "run_scenario",
        operationId,
      });
      return result;
      } catch (error) {
        if (execution && this.scenarioStore) { execution.status = "interrupted"; this.scenarioStore.write(execution); }
        throw error;
      }
    }, options.signal, lease.owner.id, options.serial, options.leaseToken);
  }

  listExecutions(serial?: string) { return this.scenarioStore?.list(serial) ?? []; }

  removeExecution(id: string, serial: string) { this.scenarioStore?.remove(id, serial); }

  async resumeScenario(id: string, serial: string, leaseToken: string, signal?: AbortSignal) {
    this.requireLease(serial, leaseToken);
    if (!this.scenarioStore) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Persistent scenario journal is unavailable");
    return await this.runScenarioInternal({ serial, leaseToken, steps: [], signal }, id);
  }

  private cancelLiveFrame(serial: string, reason: string): void {
    this.liveFrameControllers.get(serial)?.abort(reason);
    for (const [controller, deviceSerial] of this.logStreamControllers) if (deviceSerial === serial) controller.abort(reason);
  }

  private async interruptLiveFrame(serial: string, reason: string): Promise<void> {
    const inFlight = this.liveFramePromises.get(serial);
    this.cancelLiveFrame(serial, reason);
    if (inFlight && await boundedCleanup(inFlight, this.cleanupTimeoutMs) !== "complete") {
      throw new HarmonyError("DEVICE_BUSY", "A previous frame capture has not settled", { details: { dispatchState: "not-sent", cleanup: "uncertain" } });
    }
  }

  async captureLiveFrame(options: { serial: string; signal?: AbortSignal }): Promise<HarmonySnapshot> {
    validateSerial(options.serial);
    const existing = this.liveFramePromises.get(options.serial);
    if (existing) return await existing;

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? "live_frame_cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    this.liveFrameControllers.set(options.serial, controller);
    const promise = (async () => {
      const device = await this.onlineDevice(options.serial, controller.signal);
      const raw = await this.requireBackend().snapshot(options.serial, {
        includeTree: false,
        includeScreenshot: true,
        signal: controller.signal,
      });
      if (!raw.screenshot) throw new HarmonyError("INVALID_RESPONSE", "Harmony screenshot is unavailable");
      if (raw.screenshot.width && raw.screenshot.height) this.recordFrameDimensions(options.serial, "screenshot", raw.screenshot.width, raw.screenshot.height);
      const revision = (this.liveFrameRevisions.get(options.serial) ?? 0) + 1;
      this.liveFrameRevisions.set(options.serial, revision);
      return {
        serial: options.serial,
        generation: device.generation,
        revision,
        capturedAt: iso(this.now()),
        screenshot: raw.screenshot,
      };
    })().finally(() => {
      options.signal?.removeEventListener("abort", abort);
      if (this.liveFrameControllers.get(options.serial) === controller) this.liveFrameControllers.delete(options.serial);
      if (this.liveFramePromises.get(options.serial) === promise) this.liveFramePromises.delete(options.serial);
    });
    this.liveFramePromises.set(options.serial, promise);
    return await promise;
  }

  async openVideoStream(options: { serial: string; signal?: AbortSignal }): Promise<HarmonyVideoConnection> {
    validateSerial(options.serial);
    this.requireAdmission(options.serial);
    await this.onlineDevice(options.serial, options.signal);
    const backend = this.requireBackend();
    if (!backend.openVideoStream) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony video streaming is unavailable in this runtime");
    }
    const connection = await backend.openVideoStream(options.serial, options.signal);
    try { this.requireAdmission(options.serial); } catch (error) { await connection.close(); throw error; }
    let closing: Promise<void> | undefined;
    const tracked: HarmonyVideoConnection = {
      stream: connection.stream.pipeThrough(videoMetadataTransform((width, height) => {
        this.recordFrameDimensions(options.serial, "video", width, height);
      }, () => { this.frameCapturedAt.set(`${options.serial}:video`, this.now()); })),
      // A failed read-only video forward cleanup is not an unreleased key/touch.
      // The backend retains its exact port journal and close error for diagnosis.
      close: () => closing ??= connection.close().finally(() => this.videoConnections.get(options.serial)?.delete(tracked)),
    };
    const set = this.videoConnections.get(options.serial) ?? new Set<HarmonyVideoConnection>(); set.add(tracked); this.videoConnections.set(options.serial, set);
    return tracked;
  }

  private recordFrameDimensions(serial: string, space: "video" | "screenshot", width: number, height: number): void {
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16_384)) return;
    const key = `${serial}:${space}`;
    this.frameCapturedAt.set(key, this.now());
    const previous = this.frameDimensions.get(key);
    if (previous?.width !== width || previous?.height !== height) this.geometries.delete(key);
    this.frameDimensions.set(key, { width, height });
  }

  async getFrameGeometry(serial: string, space: "video" | "screenshot", signal?: AbortSignal): Promise<HarmonyGeometry> {
    const device = await this.onlineDevice(serial, signal);
    const backend = this.requireBackend();
    if (!backend.displayGeometry) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native display geometry is unavailable");
    const key = `${serial}:${space}`;
    const frame = this.frameDimensions.get(key);
    if (!frame) throw new HarmonyError("STALE_SNAPSHOT", "No server-observed frame geometry is available");
    if (this.now() - (this.frameCapturedAt.get(key) ?? 0) > 5000) throw new HarmonyError("STALE_SNAPSHOT", "The frame is stale; wait for live video or a new screenshot");
    const native = await backend.displayGeometry(serial, signal);
    // Current video and screenCap providers send the full current-orientation
    // display. A changed aspect ratio is not evidence of a known crop.
    if (Math.abs(frame.width / frame.height - native.nativeWidth / native.nativeHeight) > 0.002) {
      this.geometries.delete(key);
      throw new HarmonyError("STALE_SNAPSHOT", "Frame and native display geometry disagree; wait for a new frame");
    }
    const candidate = { ...native, deviceEpoch: device.generation, frameWidth: frame.width, frameHeight: frame.height,
      rotation: 0 as const, crop: { left: 0, top: 0, width: native.nativeWidth, height: native.nativeHeight } };
    const previous = this.geometries.get(key);
    const { geometryId: previousId, ...previousShape } = previous ?? {};
    const geometry = previousId && JSON.stringify(previousShape) === JSON.stringify(candidate) ? previous!
      : { ...candidate, geometryId: randomBytes(16).toString("hex") };
    this.geometries.set(key, geometry);
    return structuredClone(geometry);
  }

  private async inputPoint(options: Pick<HarmonyTapOptions, "serial" | "coordinateSpace" | "geometryId">, x: number, y: number, signal: AbortSignal) {
    if (options.coordinateSpace !== "frame" && !options.geometryId) {
      const backend = this.requireBackend();
      if (!backend.displayGeometry) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native coordinates require a verified display geometry provider");
      const geometry = await backend.displayGeometry(options.serial, signal);
      if (![x,y].every(Number.isFinite) || x < 0 || y < 0 || x >= geometry.nativeWidth || y >= geometry.nativeHeight) throw new HarmonyError("INVALID_ARGUMENT", "Native point is outside the observed display", { details: { dispatchState: "not-sent" } });
      return { x, y };
    }
    const entry = [...this.geometries.entries()].find(([key, value]) => key.startsWith(`${options.serial}:`) && value.geometryId === options.geometryId);
    if (!entry) throw new HarmonyError("STALE_SNAPSHOT", "The frame geometry expired; reconnect or refresh the frame");
    const space = entry[0].endsWith(":video") ? "video" : "screenshot";
    const current = await this.getFrameGeometry(options.serial, space, signal);
    if (current.geometryId !== options.geometryId) throw new HarmonyError("STALE_SNAPSHOT", "The display rotated or changed since this frame");
    if (options.coordinateSpace === "frame") return transformFramePoint(current, x, y);
    if (![x,y].every(Number.isFinite) || x < 0 || y < 0 || x >= current.nativeWidth || y >= current.nativeHeight) throw new HarmonyError("INVALID_ARGUMENT", "Native point is outside the observed display");
    return { x, y };
  }

  async captureScreenshotArtifact(options: {
    serial: string;
    leaseToken?: string;
    signal?: AbortSignal;
  }): Promise<HarmonyMediaArtifact> {
    await this.interruptLiveFrame(options.serial, "capture_screenshot");
    const snapshot = await this.snapshot({
      serial: options.serial,
      ...(options.leaseToken ? { leaseToken: options.leaseToken } : {}),
      includeTree: false,
      includeScreenshot: true,
      signal: options.signal,
    });
    if (!snapshot.screenshot) throw new HarmonyError("INVALID_RESPONSE", "Harmony screenshot is unavailable");
    return await saveHarmonyScreenshot(this.config, options.serial, snapshot.screenshot, new Date(snapshot.capturedAt));
  }

  getRecordingState(serial: string): HarmonyRecordingState | undefined {
    validateSerial(serial);
    const state = this.recordings.get(serial);
    return state ? { ...state } : undefined;
  }

  async startRecording(options: {
    serial: string;
    leaseToken?: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<HarmonyRecordingState> {
    validateSerial(options.serial);
    const lease = this.requireLease(options.serial, options.leaseToken);
    if (lease.owner.id !== options.ownerId) throw new HarmonyError("LEASE_REQUIRED", "The recording owner does not hold this device lease");
    await this.interruptLiveFrame(options.serial, "start_recording");
    return await this.enqueue("start_recording", async (signal, operationId) => {
      if (options.leaseToken) {
        const lease = this.requireLease(options.serial, options.leaseToken);
        if (lease.owner.id !== options.ownerId) throw new HarmonyError("LEASE_REQUIRED", "The recording owner does not hold this device lease");
      }
      if (this.recordings.has(options.serial)) throw new HarmonyError("DEVICE_BUSY", "This Harmony device is already recording");
      const backend = this.controlBackend(options.serial, lease.token, signal);
      if (!backend.startRecording) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony screen recording is unavailable on this device runtime");
      await this.onlineDevice(options.serial, signal);
      const recordingId = randomBytes(12).toString("hex");
      const state: HarmonyRecordingState = {
        serial: options.serial,
        recordingId,
        remoteName: `piora-recording-${recordingId}.mp4`,
        startedAt: iso(this.now()),
        ownerId: options.ownerId,
      };
      this.recoveryStore?.record(options.serial, "recording", "active");
      this.recordings.set(options.serial, state);
      // Register ownership before dispatch so a concurrent stop can reclaim it.
      try { await backend.startRecording(options.serial, state.remoteName, signal); }
      catch (error) {
        if (error instanceof HarmonyError && (error.details?.recordingStopped || error.details?.dispatchState === "not-sent")) this.recordings.delete(options.serial);
        if (error instanceof HarmonyError && (error.details?.recordingStopped || (error.details?.cleanup !== "uncertain" && error.details?.dispatchState === "not-sent"))) this.recoveryStore?.clear(options.serial, "recording");
        else { this.recoveryStore?.record(options.serial, "recording", "uncertain"); this.stoppingDevices.set(options.serial, "recovering"); }
        throw error;
      }
      if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Recording start cancelled; cleanup is required");
      const timer = setTimeout(() => { void this.stopDevice(options.serial, "recording_duration_limit"); }, 120_000);
      timer.unref?.(); this.recordingTimers.set(options.serial, timer);
      this.emit({ type: "operation", timestamp: iso(this.now()), serial: options.serial, operation: "start_recording", operationId });
      return { ...state };
    }, options.signal, options.ownerId, options.serial, lease.token);
  }

  async stopRecording(options: {
    serial: string;
    leaseToken?: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<HarmonyMediaArtifact> {
    validateSerial(options.serial);
    await this.interruptLiveFrame(options.serial, "stop_recording");
    return await this.enqueue("stop_recording", async (signal, operationId) => {
      if (options.leaseToken) {
        const lease = this.requireLease(options.serial, options.leaseToken);
        if (lease.owner.id !== options.ownerId) throw new HarmonyError("LEASE_REQUIRED", "The recording owner does not hold this device lease");
      }
      const state = this.recordings.get(options.serial);
      if (!state) throw new HarmonyError("INVALID_ARGUMENT", "This Harmony device is not recording");
      if (state.ownerId !== options.ownerId) throw new HarmonyError("DEVICE_BUSY", "The recording belongs to another controller");
      const backend = this.requireBackend();
      if (!backend.stopRecording) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony screen recording is unavailable on this device runtime");
      const destinationPath = await prepareHarmonyRecordingPath(this.config, options.serial, new Date(state.startedAt));
      try { await backend.stopRecording(options.serial, state.remoteName, destinationPath, signal); }
      catch (error) {
        if (error instanceof HarmonyError && error.details?.recordingStopped) {
          this.recordings.delete(options.serial);
          clearTimeout(this.recordingTimers.get(options.serial)); this.recordingTimers.delete(options.serial);
          // Saving/finalizing may fail after the owned reader is already closed.
          // Report that failure, but do not invent an unreleased device operation.
          this.recoveryStore?.clear(options.serial, "recording");
        } else {
          this.recoveryStore?.record(options.serial, "recording", "uncertain"); this.stoppingDevices.set(options.serial, "recovering");
        }
        throw error;
      }
      this.recordings.delete(options.serial);
      this.recoveryStore?.clear(options.serial, "recording");
      clearTimeout(this.recordingTimers.get(options.serial)); this.recordingTimers.delete(options.serial);
      const artifact = await recordingArtifact(options.serial, destinationPath, new Date());
      this.emit({ type: "operation", timestamp: iso(this.now()), serial: options.serial, operation: "stop_recording", operationId });
      return artifact;
    }, options.signal, options.ownerId, options.serial);
  }

  getLatestSnapshot(serial: string): HarmonySnapshot | undefined {
    validateSerial(serial);
    const snapshot = this.snapshots.get(serial);
    if (!snapshot) return undefined;
    return {
      serial: snapshot.serial,
      generation: snapshot.generation,
      revision: snapshot.revision,
      capturedAt: snapshot.capturedAt,
      quality: snapshot.quality,
      nodes: snapshot.nodes?.map((node) => ({ ...node, ...(node.bounds ? { bounds: { ...node.bounds } } : {}) })),
    };
  }

  private async action(
    operation: string,
    serial: string,
    leaseToken: string,
    generation: number | undefined,
    signal: AbortSignal | undefined,
    invoke: (backend: HarmonyAutomationBackend, queuedSignal: AbortSignal) => Promise<void>,
  ): Promise<HarmonyOperationResult> {
    validateSerial(serial);
    const lease = this.requireLease(serial, leaseToken);
    await this.interruptLiveFrame(serial, operation);
    return await this.enqueue(operation, async (queuedSignal, operationId) => {
      this.requireLease(serial, leaseToken);
      const device = await this.onlineDevice(serial, queuedSignal);
      if (generation !== undefined && generation !== device.generation) {
        throw new HarmonyError("STALE_SNAPSHOT", "The device reconnected after this snapshot was captured", {
          details: { expectedGeneration: device.generation, receivedGeneration: generation },
          retryable: true,
        });
      }
      // Any write may change the page, even when the device command later fails.
      // The public "latest snapshot" is therefore invalidated. Lightweight
      // semantic refs are retained separately and must pass a fresh, unique
      // live-tree match before they can be reused.
      this.snapshots.delete(serial);
      const startedAt = iso(this.now());
      const ownsHold = ["key_hold", "touch_hold", "voice_input", "open_assistant"].includes(operation);
      const dispatch = () => invoke(this.controlBackend(serial, leaseToken, queuedSignal), queuedSignal);
      if (ownsHold) await this.withInputRecovery(serial, lease, dispatch);
      else await dispatch();
      if (queuedSignal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled; its effect may be unknown", { details: { dispatchState: "sent" } });
      this.emit({ type: "operation", timestamp: iso(this.now()), serial, operation, operationId });
      return { serial, operationId, generation: device.generation, completedAt: iso(this.now()),
        receipt: { action: operation, dispatchState: "sent", effect: "unknown", verification: "not-run",
          provider: this.requireBackend().kind, deviceEpoch: device.generation, leaseEpoch: lease.leaseEpoch, startedAt, completedAt: iso(this.now()) },
      };
    }, signal, lease.owner.id, serial, leaseToken);
  }

  async tap(options: HarmonyTapOptions): Promise<HarmonyOperationResult> {
    return await this.action("tap", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        const point = await this.inputPoint(options, options.x, options.y, signal);
        await backend.tap(options.serial, point.x, point.y, signal);
      });
  }

  private calibrations() { return this.inputCalibration ??= new InputCalibrationStore(join(dirname(this.configPath), "harmony-input-calibration")); }

  async confirmInputCalibration(serial: string, id: string, assistant?: { appId: string; selector: import("./types").HarmonyUiSelector }) {
    if (assistant) {
      validateHarmonySelector(assistant.selector);
      const snapshot = await this.snapshot({ serial, includeTree: true, includeScreenshot: false }); requireValidObservation(snapshot);
      if (snapshot.quality?.appId !== assistant.appId || findHarmonyNodes(snapshot.nodes ?? [], assistant.selector).length !== 1) throw new HarmonyError("SCENARIO_FAILED", "The assistant postcondition is not uniquely visible on this device");
    }
    return this.calibrations().confirm(await this.onlineDevice(serial), id, assistant);
  }

  async openAssistant(options: { serial: string; leaseToken: string; profileId: string; signal?: AbortSignal }) {
    const result = await this.action("open_assistant", options.serial, options.leaseToken, undefined, options.signal, async (backend, signal) => {
      const profile = this.calibrations().assistant(await this.onlineDevice(options.serial, signal), options.profileId);
      if (!backend.keyHold) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Physical key hold is unavailable");
      await backend.keyHold(options.serial, "power", profile.durationMs, signal);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !signal.aborted) {
        const snapshot = await this.captureSnapshotNow(options.serial, true, false, signal); requireValidObservation(snapshot);
        if (snapshot.quality?.appId === profile.assistant!.appId && findHarmonyNodes(snapshot.nodes ?? [], profile.assistant!.selector).length === 1) return;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new HarmonyError(signal.aborted ? "COMMAND_ABORTED" : "SCENARIO_FAILED", "Assistant did not reach its calibrated postcondition");
    });
    return { ...result, receipt: { ...result.receipt!, effect: "applied" as const, verification: "passed" as const } };
  }

  private audioStore() { return this.audioAssets ??= new AudioAssetStore(join(dirname(this.configPath), "harmony-audio-assets")); }
  private voiceStore() { return this.voiceProfiles ??= new VoiceProfileStore(join(dirname(this.configPath), "harmony-voice-profiles")); }
  async audioOutputs(signal?: AbortSignal) { return await this.acoustic.outputs(signal); }
  async importAudio(path: string) { return await this.audioStore().import(path); }

  async appTestAudio(options: { serial: string; leaseToken: string; audioAssetId: string; pairing: AppTestPairing; signal?: AbortSignal }) {
    let hashResult: string | undefined;
    const receipt = await this.action("app_test_audio", options.serial, options.leaseToken, undefined, options.signal, async (backend, signal) => {
      const lease = this.requireLease(options.serial, options.leaseToken);
      if (lease.owner.kind !== "manual" || !backend.appTestAudio) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Debug PCM pairing is available only through explicit desktop manual control");
      const source = await this.audioStore().resolve(options.audioAssetId);
      const packet = appTestPacket(await readFile(source.path), options.pairing, lease.owner.id);
      const initial = await this.captureSnapshotNow(options.serial, true, false, signal);
      if (initial.quality?.treeStatus !== "valid" || initial.quality.appId !== "dev.piora.audio.fixture" || !initial.nodes?.some(node => node.id === "app-test-result" && node.text === "ready")) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Open and pair the debug fixture on this device first");
      await backend.appTestAudio(options.serial, packet.packet, signal);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !signal.aborted) {
        const snapshot = await this.captureSnapshotNow(options.serial, true, false, signal);
        if (snapshot.quality?.treeStatus !== "valid" || snapshot.quality.appId !== initial.quality.appId || snapshot.quality.windowId !== initial.quality.windowId) throw new HarmonyError("STALE_SNAPSHOT", "Debug app lost focus");
        if (snapshot.nodes?.some(node => node.id === "app-test-result" && node.text === packet.expected)) { hashResult = packet.expected; return; }
        if (snapshot.nodes?.some(node => node.id === "app-test-result" && node.text === "rejected")) throw new HarmonyError("SCENARIO_FAILED", "Debug app rejected the PCM packet");
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new HarmonyError(signal.aborted ? "COMMAND_ABORTED" : "COMMAND_TIMEOUT", "Debug PCM result was not verified");
    });
    return { ...receipt, provider: "app-test", verification: hashResult, coversMicrophone: false, coversSpeechRecognition: false };
  }

  async voiceInput(options: { serial: string; leaseToken: string; audioAssetId: string; profileId?: string; timeoutMs?: number; geometryId?: string; requiredMode?: "tap" | "push-to-talk"; signal?: AbortSignal;
    calibrateProfile?: Pick<VoiceProfile, "targetAppId" | "output" | "entry" | "ready" | "result" | "mode" | "holdDurationMs"> }) {
    let voice: Awaited<ReturnType<HarmonyDeviceManager["executeVoice"]>> | undefined;
    const result = await this.action("voice_input", options.serial, options.leaseToken, undefined, options.signal, async (backend, signal) => {
      voice = await this.executeVoice(options, backend, signal);
    });
    return { ...result, ...voice };
  }

  private async withInputRecovery<T>(serial: string, lease: HarmonyLease, operation: () => Promise<T>): Promise<T> {
    this.recoveryStore?.record(serial, "input", "active");
    try { const result = await operation(); this.recoveryStore?.clear(serial, "input"); return result; }
    catch (error) {
      if (error instanceof HarmonyError && error.details?.cleanup === "uncertain") {
        this.uncertainInput.add(serial);
        this.recoveryStore?.record(serial, "input", "uncertain");
        this.stoppingDevices.set(serial, "recovering");
        this.removeLease(lease, "uncertain_input_release");
      } else this.recoveryStore?.clear(serial, "input");
      throw error;
    }
  }

  async previewAudio(audioAssetId: string, output: import("./audio/acoustic-provider").AudioOutput, signal?: AbortSignal) {
    const immutable = await this.audioStore().resolve(audioAssetId);
    return this.acoustic.play(output, immutable.path, signal);
  }

  private async executeVoice(options: Parameters<HarmonyDeviceManager["voiceInput"]>[0], backend: HarmonyAutomationBackend, signal: AbortSignal) {
    let calibratedProfile: VoiceProfile | undefined;
      const device = await this.onlineDevice(options.serial, signal);
      const profile = options.calibrateProfile ?? this.voiceStore().get(device, options.profileId ?? "");
      validateVoiceProfile(profile);
      if (options.requiredMode && options.requiredMode !== profile.mode) throw new HarmonyError("INVALID_ARGUMENT", "Voice profile mode does not match this scenario", { details: { dispatchState: "not-sent" } });
      const outputs = await this.acoustic.outputs(signal);
      if (!outputs.some(output => output.id === profile.output?.id && output.name === profile.output?.name && output.provider === profile.output?.provider)) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Selected acoustic output changed; choose and calibrate it again", { details: { dispatchState: "not-sent" } });
      const { asset } = await this.audioStore().resolve(options.audioAssetId);
      if (profile.mode === "push-to-talk") {
        if (!options.geometryId || !backend.touchHold || !profile.holdDurationMs) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Voice touch mode requires fresh geometry and calibrated touch hold");
        this.calibrations().require(device, "touch", profile.holdDurationMs);
      }
      let heldGeometry: HarmonyGeometry | undefined;
      const voiceResult = await runVoiceInput(profile, asset, {
        serial: options.serial, backend, signal,
        beforeDispatch: () => { this.requireLease(options.serial, options.leaseToken); },
        capture: async captureSignal => await this.captureSnapshotNow(options.serial, true, false, captureSignal),
        validateHold: async holdSignal => {
          if (!heldGeometry) return;
          const native = await backend.displayGeometry!(options.serial, holdSignal);
          if (native.displayId !== heldGeometry.displayId || native.displayRotation !== heldGeometry.displayRotation || native.nativeWidth !== heldGeometry.nativeWidth || native.nativeHeight !== heldGeometry.nativeHeight) throw new HarmonyError("STALE_SNAPSHOT", "Voice hold geometry changed");
        },
        play: async playSignal => { const immutable = await this.audioStore().resolve(asset.id); return await this.acoustic.play(profile.output, immutable.path, playSignal); },
        hold: async (point, durationMs, holdSignal) => {
          await this.inputPoint({ serial: options.serial, coordinateSpace: "native", geometryId: options.geometryId }, point.x, point.y, holdSignal);
          heldGeometry = [...this.geometries.values()].find(geometry => geometry.geometryId === options.geometryId);
          if (!heldGeometry) throw new HarmonyError("STALE_SNAPSHOT", "Voice hold geometry expired before dispatch");
          return await backend.touchHold!(options.serial, point.x, point.y, durationMs, holdSignal);
        },
      }, options.timeoutMs);
      if (options.calibrateProfile) calibratedProfile = this.voiceStore().save(device, { ...profile, calibrationAssetHash: asset.hash });
    return { voice: voiceResult, ...(calibratedProfile ? { profile: calibratedProfile } : {}) };
  }

  async keyHold(options: { serial: string; leaseToken: string; key: PhysicalKey; durationMs: number; calibrate?: boolean; signal?: AbortSignal }) {
    let calibration: ReturnType<InputCalibrationStore["record"]> | undefined;
    const result = await this.action("key_hold", options.serial, options.leaseToken, undefined, options.signal, async (backend, signal) => {
      const device = await this.onlineDevice(options.serial, signal);
      if (!backend.keyHold) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "No safe key hold provider");
      if (!options.calibrate) this.calibrations().require(device, "key", options.durationMs, options.key);
      await backend.keyHold(options.serial, options.key, options.durationMs, signal);
      if (options.calibrate) calibration = this.calibrations().record(device, "key", options.durationMs, options.key);
    });
    return { ...result, ...(calibration ? { calibration } : {}) };
  }

  async touchHold(options: HarmonyTapOptions & { durationMs: number; calibrate?: boolean }) {
    let calibration: ReturnType<InputCalibrationStore["record"]> | undefined;
    const result = await this.action("touch_hold", options.serial, options.leaseToken, options.generation, options.signal, async (backend, signal) => {
      const device = await this.onlineDevice(options.serial, signal);
      if (!options.geometryId || !backend.touchHold) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Touch hold requires current geometry and a safe release provider");
      const point = await this.inputPoint(options, options.x, options.y, signal);
      const initial = await backend.snapshot(options.serial, { includeTree: true, includeScreenshot: false, signal });
      if (!initial.quality?.windowId) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Touch hold requires an observed window identity so focus changes can stop it");
      if (!options.calibrate) this.calibrations().require(device, "touch", options.durationMs);
      const controller = new AbortController();
      const inner = AbortSignal.any([signal, controller.signal]);
      let checking = false;
      const timer = setInterval(() => { if (checking || inner.aborted) return; checking = true;
        void (async () => {
          await this.inputPoint(options, options.x, options.y, inner);
          const observation = await backend.snapshot(options.serial, { includeTree: true, includeScreenshot: false, signal: inner });
          if (observation.quality?.windowId !== initial.quality?.windowId) controller.abort("focus_changed");
        })().catch(() => controller.abort("geometry_or_focus_unknown")).finally(() => { checking = false; });
      }, 250);
      try { await backend.touchHold(options.serial, point.x, point.y, options.durationMs, inner); }
      finally { clearInterval(timer); controller.abort("touch_hold_complete"); }
      if (options.calibrate) calibration = this.calibrations().record(device, "touch", options.durationMs);
    });
    return { ...result, ...(calibration ? { calibration } : {}) };
  }

  async doubleTap(options: HarmonyPointGestureOptions): Promise<HarmonyOperationResult> {
    return await this.action("double_tap", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.doubleTap) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony double-tap injection is unavailable");
        const point = await this.inputPoint(options, options.x, options.y, signal);
        await backend.doubleTap(options.serial, point.x, point.y, signal);
      });
  }

  async longPress(options: HarmonyPointGestureOptions): Promise<HarmonyOperationResult> {
    return await this.action("long_press", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.longPress) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony long-press injection is unavailable");
        const point = await this.inputPoint(options, options.x, options.y, signal);
        await backend.longPress(options.serial, point.x, point.y, signal);
      });
  }

  async tapRef(options: HarmonyTapRefOptions): Promise<HarmonyOperationResult> {
    validateSerial(options.serial);
    if (!Number.isSafeInteger(options.generation) || options.generation < 0) {
      throw new HarmonyError("INVALID_ARGUMENT", "A valid UI reference generation is required");
    }
    const identity = /^g(\d+)-r(\d+)-n(\d+)$/.exec(options.ref);
    if (!identity) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony UI reference");
    const refGeneration = Number(identity[1]);
    const refRevision = Number(identity[2]);
    if (!Number.isSafeInteger(refGeneration) || !Number.isSafeInteger(refRevision) || refGeneration !== options.generation) {
      throw new HarmonyError("STALE_SNAPSHOT", "The UI reference does not belong to the requested device generation", { retryable: true });
    }
    const referenceSnapshot = this.referenceSnapshots.get(options.serial)?.find((entry) => (
      entry.generation === options.generation && entry.revision === refRevision
    ));
    if (!referenceSnapshot) {
      throw new HarmonyError("STALE_SNAPSHOT", "The referenced snapshot is no longer retained; observe the screen and use a fresh ref", { retryable: true });
    }
    if (this.now() - Date.parse(referenceSnapshot.capturedAt) > 30_000) {
      throw new HarmonyError("STALE_SNAPSHOT", "The UI reference is older than 30 seconds; observe again", { retryable: true });
    }
    const node = referenceSnapshot.nodeByRef.get(options.ref);
    if (!node?.bounds) throw new HarmonyError("INVALID_ARGUMENT", "UI reference does not have tappable bounds");
    if (node.enabled === false || node.visible === false) throw new HarmonyError("INVALID_ARGUMENT", "UI reference is not enabled or visible");
    if (node.clickable === false) throw new HarmonyError("INVALID_ARGUMENT", "UI reference is not clickable");
    const current = this.snapshots.get(options.serial);
    const strategy = current?.generation === options.generation && current.revision === refRevision
      ? "semantic_ref"
      : "retained_semantic_ref";
    let tappedX = Math.round((node.bounds.left + node.bounds.right) / 2);
    let tappedY = Math.round((node.bounds.top + node.bounds.bottom) / 2);
    const result = await this.action("tap_ref", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        // Snapshot revisions are local bookkeeping, not an atomic device-side
        // transaction. Re-read the tree immediately before tapping and require
        // the same uniquely identifiable target at nearly the same location.
        const fresh = await backend.snapshot(options.serial, { includeTree: true, includeScreenshot: false, signal });
        requireValidObservation(fresh);
        if (this.now() - Date.parse(referenceSnapshot.capturedAt) > 30_000
          || referenceSnapshot.quality?.windowId !== fresh.quality?.windowId
          || referenceSnapshot.quality?.appId !== fresh.quality?.appId) {
          throw new HarmonyError("STALE_SNAPSHOT", "The reference expired or its active app/window changed", { details: { dispatchState: "not-sent" } });
        }
        const match = resolveRetainedTarget(node, fresh);
        this.requireLease(options.serial, options.leaseToken);
        if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled");
        const bounds = match.bounds;
        tappedX = Math.round((bounds.left + bounds.right) / 2);
        tappedY = Math.round((bounds.top + bounds.bottom) / 2);
        await backend.tap(
          options.serial,
          tappedX,
          tappedY,
          signal,
        );
      });
    return { ...result, strategy, x: tappedX, y: tappedY };
  }

  async swipe(options: HarmonySwipeOptions): Promise<HarmonyOperationResult> {
    return await this.action("swipe", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        const from = await this.inputPoint(options, options.fromX, options.fromY, signal);
        const to = await this.inputPoint(options, options.toX, options.toY, signal);
        await backend.swipe(options.serial, from.x, from.y, to.x, to.y, options.durationMs, signal);
      });
  }

  async drag(options: HarmonyDragOptions): Promise<HarmonyOperationResult> {
    return await this.action("drag", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.drag) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony drag injection is unavailable");
        const from = await this.inputPoint(options, options.fromX, options.fromY, signal);
        const to = await this.inputPoint(options, options.toX, options.toY, signal);
        await backend.drag(options.serial, from.x, from.y, to.x, to.y, options.durationMs, signal);
      });
  }

  async fling(options: HarmonyFlingOptions): Promise<HarmonyOperationResult> {
    return await this.action("fling", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.fling) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony fling injection is unavailable");
        const from = await this.inputPoint(options, options.fromX, options.fromY, signal);
        const to = await this.inputPoint(options, options.toX, options.toY, signal);
        await backend.fling(options.serial, from.x, from.y, to.x, to.y, options.durationMs, signal);
      });
  }

  async inputText(options: HarmonyInputTextOptions): Promise<HarmonyOperationResult> {
    return await this.action("input_text", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => await backend.inputText(options.serial, options.text, signal));
  }

  async pressKey(options: HarmonyPressKeyOptions): Promise<HarmonyOperationResult> {
    return await this.action("press_key", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => await backend.pressKey(options.serial, options.key, signal));
  }

  async launchApp(options: HarmonyLaunchAppOptions): Promise<HarmonyOperationResult> {
    return await this.action("launch_app", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => await backend.launchApp(options.serial, options.bundleName, options.abilityName, signal));
  }

  async installPackage(options: HarmonyInstallAppOptions): Promise<HarmonyOperationResult> {
    return await this.action("install_package", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.installPackage) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony package installation is unavailable");
        await backend.installPackage(options.serial, options.hapPath, options.replace ?? true, signal);
      });
  }

  async stopApp(options: { serial: string; leaseToken: string; bundleName: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("stop_app", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.stopApp) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Stopping applications is unavailable");
        await backend.stopApp(options.serial, options.bundleName, signal);
      });
  }

  async clearAppData(options: { serial: string; leaseToken: string; bundleName: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("clear_app_data", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.clearAppData) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Clearing application data is unavailable");
        await backend.clearAppData(options.serial, options.bundleName, signal);
      });
  }

  async uninstallApp(options: { serial: string; leaseToken: string; bundleName: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("uninstall_app", options.serial, options.leaseToken, undefined, options.signal,
      async (backend, signal) => {
        if (!backend.uninstallPackage) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Uninstalling applications is unavailable");
        await backend.uninstallPackage(options.serial, options.bundleName, signal);
      });
  }

  getConfig(): HarmonyConfig {
    return {
      ...this.config,
      ...(this.config.storage ? { storage: { ...this.config.storage } } : {}),
      ...(this.config.vision ? { vision: { ...this.config.vision } } : {}),
    };
  }

  async initializeMirror(options: { serial: string; leaseToken: string; signal?: AbortSignal }): Promise<HarmonyOperationResult> {
    return await this.action("initialize_mirror", options.serial, options.leaseToken, undefined, options.signal, async (_backend, signal) => {
      const backend = this.requireBackend();
      if (!backend.mirrorPackagePath || !backend.initializeMirror) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Video initialization is unavailable");
      const artifactPath = await importHapArtifact(backend.mirrorPackagePath(), join(dirname(this.configPath), "harmony-artifacts"));
      this.requireLease(options.serial, options.leaseToken);
      if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Video initialization was cancelled");
      await backend.initializeMirror(options.serial, artifactPath, signal);
    });
  }

  async updateConfig(
    patch: { hdcPath?: string | null; storage?: HarmonyConfig["storage"] | null; vision?: HarmonyConfig["vision"] | null },
    signal?: AbortSignal,
  ): Promise<HarmonyConfig> {
    if (this.injectedBackend) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Injected Harmony backends cannot be reconfigured");
    const next: HarmonyConfig = { ...this.config };
    if (patch.hdcPath === null || patch.hdcPath === "") delete next.hdcPath;
    else if (patch.hdcPath !== undefined) next.hdcPath = patch.hdcPath;
    if (patch.storage === null) delete next.storage;
    else if (patch.storage !== undefined) next.storage = { ...patch.storage };
    if (patch.vision === null) delete next.vision;
    else if (patch.vision !== undefined) next.vision = patch.vision;
    const previousConfig = this.config;
    const runtimeChanged = next.hdcPath !== previousConfig.hdcPath;
    let candidateBackend: HarmonyAutomationBackend | undefined;
    if (runtimeChanged) {
      // Validate the candidate before persisting it or disturbing the working
      // backend. A bad picker choice must not strand the user on restart.
      candidateBackend = this.backendFactory(next);
      try {
        await candidateBackend.listDevices(signal);
      } catch (error) {
        await Promise.resolve(candidateBackend.dispose?.()).catch(() => undefined);
        throw error;
      }
    }
    let normalized: HarmonyConfig;
    try {
      normalized = writeHarmonyConfig(next, this.configPath);
    } catch (error) {
      await candidateBackend?.dispose?.();
      throw error;
    }
    this.config = normalized;
    if (runtimeChanged && candidateBackend) {
      const previousBackend = this.backend;
      await this.emergencyStop("configuration_changed");
      this.backend = candidateBackend;
      this.runtimeError = undefined;
      await Promise.resolve(previousBackend?.dispose?.()).catch(() => undefined);
    }
    return this.getConfig();
  }

  async getDiagnostics(): Promise<HarmonyDiagnostics> {
    this.sweepExpiredLeases();
    return {
      timestamp: iso(this.now()),
      config: this.getConfig(),
      runtime: {
        status: this.runtimeError ? "error" : this.backend ? "ready" : "unresolved",
        ...(this.backend?.hdcPath ? { hdcPath: this.backend.hdcPath } : {}),
        ...(this.backend ? { backendKind: this.backend.kind } : {}),
        ...(this.runtimeError ? { error: this.runtimeError.toJSON() } : {}),
      },
      deviceCount: this.devices.size,
      onlineDeviceCount: [...this.devices.values()].filter((device) => device.state === "online").length,
      activeLeaseCount: this.leasesByToken.size,
      queue: { pending: this.pending, active: this.activeCount > 0, epoch: this.queueEpoch },
      ...(this.backend?.automationDiagnostics ? { automation: this.backend.automationDiagnostics() } : {}),
    };
  }

  async supportBundle(options: { serial?: string; includeTree?: boolean; includeScreenshot?: boolean; signal?: AbortSignal }) {
    const snapshot = options.serial && (options.includeTree || options.includeScreenshot) ? await this.snapshot({ serial: options.serial, includeTree: Boolean(options.includeTree), includeScreenshot: Boolean(options.includeScreenshot), signal: options.signal }) : undefined;
    return await saveSupportBundle(join(dirname(this.configPath), "harmony-support"), createSupportBundle(this.getState(options.serial), await this.getDiagnostics(), { ...options, snapshot }));
  }

  getState(serial?: string): HarmonyManagerState {
    this.sweepExpiredLeases();
    const devices = [...this.devices.values()].filter((device) => !serial || device.serial === serial);
    return {
      runtime: {
        status: this.runtimeError ? "error" : this.backend ? "ready" : "unresolved",
        ...(this.backend?.hdcPath ? { hdcPath: this.backend.hdcPath } : {}),
        ...(this.runtimeError ? { error: this.runtimeError.toJSON() } : {}),
      },
      devices,
      controls: [...this.stoppingDevices].filter(([deviceSerial]) => !serial || deviceSerial === serial)
        .map(([deviceSerial, status]) => ({ serial: deviceSerial, status, cleanup: status === "stopping" ? "pending" : "uncertain" })),
      leases: [...this.leasesByToken.values()].filter((lease) => !serial || lease.serial === serial),
      snapshots: [...this.snapshots.values()]
        .filter((snapshot) => !serial || snapshot.serial === serial)
        .map((snapshot) => ({
          serial: snapshot.serial,
          generation: snapshot.generation,
          revision: snapshot.revision,
          capturedAt: snapshot.capturedAt,
          hasTree: snapshot.tree !== undefined,
          hasScreenshot: snapshot.screenshot !== undefined,
        })),
    };
  }

  async confirmCleanup(serial: string, signal?: AbortSignal) {
    validateSerial(serial);
    if (this.cleanupUnsettled.has(serial) || this.stopPromises.has(serial) || this.operationLanes.get(`device:${serial}`)?.active || this.operationLanes.get(`device:${serial}`)?.pending || this.recordings.has(serial)) throw new HarmonyError("DEVICE_BUSY", "Wait for owned operations and recording cleanup to settle before confirming");
    if (!this.stoppingDevices.has(serial)) return { cleanup: "complete" as const };
    await this.onlineDevice(serial, signal);
    const observation = await this.requireBackend().snapshot(serial, { includeTree: true, includeScreenshot: false, signal });
    requireValidObservation(observation);
    // Human confirmation is distinct from a driver-verified release.
    this.uncertainInput.delete(serial); this.cleanupWork.delete(serial);
    this.recoveryStore?.clear(serial);
    this.physicalLocks.get(serial)?.release(); this.physicalLocks.delete(serial);
    this.stoppingDevices.delete(serial);
    this.emit({ type: "state", timestamp: iso(this.now()), state: this.getState() });
    return { cleanup: "manual-confirmed" as const };
  }

  stopDevice(serial: string, reason = "device_stop"): Promise<{ dispatchBlocked: true; cleanup: "complete" | "uncertain" }> {
    validateSerial(serial);
    const existing = this.stopPromises.get(serial);
    if (existing) return existing;
    const hadPhysicalControl = this.leasesBySerial.has(serial) || this.physicalLocks.has(serial) || this.uncertainInput.has(serial);
    // The fence is synchronous and precedes all asynchronous resource cleanup.
    this.stoppingDevices.set(serial, "stopping");
    const lease = this.leasesBySerial.get(serial);
    if (lease) this.removeLease(lease, reason);
    for (const controller of this.controllersByDevice.get(serial) ?? []) controller.abort(reason);
    this.liveFrameControllers.get(serial)?.abort(reason);
    for (const [controller, deviceSerial] of this.logStreamControllers) if (deviceSerial === serial) controller.abort(reason);
    this.forgetDeviceSnapshots(serial);
    const generation = (this.generations.get(serial) ?? 0) + 1;
    this.generations.set(serial, generation);
    const device = this.devices.get(serial);
    if (device) this.devices.set(serial, { ...device, generation });
    clearTimeout(this.recordingTimers.get(serial)); this.recordingTimers.delete(serial);
    const cleanupController = new AbortController();
    let inputCleanupComplete = false;
    const cleanupWork = this.cleanupWork.get(serial) ?? Promise.allSettled([
      Promise.allSettled([this.operationLanes.get(`device:${serial}`)?.tail, this.backend?.resetAutomation?.(serial)]).then(results => {
        inputCleanupComplete = results.every(result => result.status === "fulfilled");
        if (!inputCleanupComplete) throw new Error("Device input cleanup failed");
      }),
      this.liveFramePromises.get(serial),
      ...[...(this.videoConnections.get(serial) ?? [])].map(connection => connection.close()),
      (async () => {
        // The start operation may still be settling when the stop fence is raised.
        await this.operationLanes.get(`device:${serial}`)?.tail;
        const recording = this.recordings.get(serial);
        if (!recording) return;
        if (!this.backend?.stopRecording) throw new Error("Recording cleanup unavailable");
        const path = await prepareHarmonyRecordingPath(this.config, serial, new Date(recording.startedAt));
        try { await this.backend.stopRecording(serial, recording.remoteName, path, cleanupController.signal); }
        catch (error) { if (error instanceof HarmonyError && error.details?.recordingStopped) this.recordings.delete(serial); throw error; }
        if (this.recordings.get(serial) === recording) this.recordings.delete(serial);
      })(),
    ]).then(results => { if (results.some(result => result.status === "rejected")) throw new Error("A device resource could not be cleaned up"); });
    this.cleanupUnsettled.add(serial);
    void cleanupWork.finally(() => this.cleanupUnsettled.delete(serial)).catch(() => undefined);
    this.cleanupWork.set(serial, cleanupWork);
    const finishCleanup = () => {
      this.cleanupWork.delete(serial);
      this.recoveryStore?.clear(serial);
      this.physicalLocks.get(serial)?.release();
      this.physicalLocks.delete(serial);
      this.stoppingDevices.delete(serial);
    };
    const stopping = boundedCleanup(cleanupWork, this.cleanupTimeoutMs).then(result => {
      const cleanup = this.uncertainInput.has(serial) ? "uncertain" : result;
      if (cleanup === "complete") finishCleanup();
      else if ((!hadPhysicalControl || inputCleanupComplete) && !this.uncertainInput.has(serial) && !this.recordings.has(serial)
        && !this.operationLanes.get(`device:${serial}`)?.active && !this.operationLanes.get(`device:${serial}`)?.pending) {
        // Video forwarding or file finalization can fail after input is released.
        // Preserve the backend warning/receipt without persisting a false input latch.
        finishCleanup();
      }
      else {
        cleanupController.abort("cleanup_timeout"); this.stoppingDevices.set(serial, "recovering"); this.recoveryStore?.record(serial, "input", "uncertain");
        // A deadline is not a failed release. Restore admission automatically if
        // the exact cleanup later succeeds; unknown physical input stays fenced.
        void cleanupWork.then(() => {
          if (this.cleanupWork.get(serial) !== cleanupWork || this.uncertainInput.has(serial)) return;
          finishCleanup();
          this.emit({ type: "state", timestamp: iso(this.now()), state: this.getState() });
        }).catch(() => undefined);
      }
      this.emit({ type: "state", timestamp: iso(this.now()), state: this.getState() });
      return { dispatchBlocked: true as const, cleanup };
    }).finally(() => { this.stopPromises.delete(serial); });
    this.stopPromises.set(serial, stopping);
    return stopping;
  }

  async emergencyStop(reason = "emergency_stop"): Promise<void> {
    this.stoppingAll = true;
    this.queueEpoch += 1;
    this.lastDeviceRefreshAt = Number.NEGATIVE_INFINITY;
    for (const controller of this.activeControllers) controller.abort(reason);
    this.deviceRefreshController?.abort(reason);
    const serials = new Set([...this.generations.keys(), ...this.leasesBySerial.keys(), ...this.recordings.keys()]);
    try {
      await Promise.all([...serials].map(serial => this.stopDevice(serial, reason)));
      if (this.deviceRefreshPromise) await boundedCleanup(this.deviceRefreshPromise, this.cleanupTimeoutMs);
    } finally { this.stoppingAll = false; }
  }

  async dispose(): Promise<{ cleanup: "complete" | "uncertain" }> {
    if (this.disposed) return { cleanup: this.stoppingDevices.size ? "uncertain" : "complete" };
    for (const controller of this.logStreamControllers.keys()) controller.abort();
    this.disposed = true;
    await this.emergencyStop("disposed");
    const cleanup = await boundedCleanup(Promise.resolve(this.backend?.dispose?.()), this.cleanupTimeoutMs);
    this.listeners.clear();
    return { cleanup: this.stoppingDevices.size ? "uncertain" : cleanup };
  }
}
