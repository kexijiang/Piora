import { randomBytes } from "node:crypto";

import { asHarmonyError, HarmonyError } from "./errors";
import { createHybridHarmonyBackend } from "./hybrid-backend";
import { runHarmonyScenario } from "./scenario-executor";
import {
  defaultHarmonyConfigPath,
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
  generation: number;
  revision: number;
  nodeByRef: Map<string, HarmonyUiNode>;
}

interface OperationLane {
  tail: Promise<void>;
  pending: number;
  active: boolean;
}

function normalizedLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function boundsDistance(left: HarmonyUiNode, right: Omit<HarmonyUiNode, "ref" | "parentRef">): number {
  if (!left.bounds || !right.bounds) return Number.POSITIVE_INFINITY;
  const leftX = (left.bounds.left + left.bounds.right) / 2;
  const leftY = (left.bounds.top + left.bounds.bottom) / 2;
  const rightX = (right.bounds.left + right.bounds.right) / 2;
  const rightY = (right.bounds.top + right.bounds.bottom) / 2;
  return Math.hypot(leftX - rightX, leftY - rightY);
}

function isSameUiTarget(target: HarmonyUiNode, candidate: Omit<HarmonyUiNode, "ref" | "parentRef">): boolean {
  if (!candidate.bounds || candidate.enabled === false || candidate.visible === false) return false;
  if (target.clickable === true && candidate.clickable !== true) return false;
  if (target.type && candidate.type !== target.type) return false;
  if (target.id && candidate.id !== target.id) return false;

  const labels = ["text", "hint", "description"] as const;
  const stableLabels = labels.filter((key) => normalizedLabel(target[key]) !== undefined);
  if (!target.id && stableLabels.length === 0 && !target.bounds) return false;
  if (stableLabels.some((key) => normalizedLabel(candidate[key]) !== normalizedLabel(target[key]))) return false;

  if (!target.bounds) return Boolean(target.id || stableLabels.length > 0);
  const width = Math.max(1, target.bounds.right - target.bounds.left);
  const height = Math.max(1, target.bounds.bottom - target.bounds.top);
  const tolerance = Math.max(8, Math.min(width, height) * 0.15);
  return boundsDistance(target, candidate) <= tolerance;
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
  private readonly liveFramePromises = new Map<string, Promise<HarmonySnapshot>>();
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
  private disposed = false;
  private lastDeviceRefreshAt = Number.NEGATIVE_INFINITY;
  private deviceRefreshPromise?: Promise<HarmonyDevice[]>;
  private deviceRefreshController?: AbortController;

  constructor(options: HarmonyDeviceManagerOptions = {}) {
    this.configPath = options.configPath ?? defaultHarmonyConfigPath();
    this.config = readHarmonyConfig(this.configPath);
    this.now = options.now ?? Date.now;
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
  }

  private retainSnapshotReferences(serial: string, snapshot: StoredSnapshot): void {
    const history = (this.referenceSnapshots.get(serial) ?? [])
      .filter((entry) => entry.generation === snapshot.generation && entry.revision !== snapshot.revision);
    history.push({
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

  private withAbort(parent?: AbortSignal, ownerId?: string): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) controller.abort(parent.reason);
    else parent?.addEventListener("abort", abort, { once: true });
    this.activeControllers.add(controller);
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
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new HarmonyError("INTERNAL_ERROR", "Harmony device manager is disposed"));
    const epoch = this.queueEpoch;
    const operationId = ++this.operationId;
    const abort = this.withAbort(parentSignal, ownerId);
    const laneKey = serial ? `device:${serial}` : "global";
    const lane = this.operationLanes.get(laneKey) ?? { tail: Promise.resolve(), pending: 0, active: false };
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

  private removeLease(lease: HarmonyLease, reason: string): void {
    this.leasesByToken.delete(lease.token);
    if (this.leasesBySerial.get(lease.serial)?.token === lease.token) this.leasesBySerial.delete(lease.serial);
    this.emit({
      type: "lease_released",
      timestamp: iso(this.now()),
      serial: lease.serial,
      ownerId: lease.owner.id,
      reason,
    });
  }

  private requireLease(serial: string, token: string | undefined): HarmonyLease {
    this.sweepExpiredLeases();
    if (!token) throw new HarmonyError("LEASE_REQUIRED", "An active device lease is required");
    const lease = this.leasesByToken.get(token);
    if (!lease || lease.serial !== serial) {
      throw new HarmonyError("LEASE_REQUIRED", "The device lease is missing or belongs to another device");
    }
    if (Date.parse(lease.expiresAt) <= this.now()) {
      this.removeLease(lease, "expired");
      throw new HarmonyError("LEASE_EXPIRED", "The device lease has expired", { retryable: true });
    }
    return lease;
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
      if (!previous || previous.generation !== generation) this.forgetDeviceSnapshots(device.serial);
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

  private async onlineDevice(serial: string, signal?: AbortSignal): Promise<HarmonyDevice> {
    const cached = this.devices.get(serial);
    const device = cached?.state === "online" && this.now() - this.lastDeviceRefreshAt < DEVICE_REFRESH_TTL_MS
      ? cached
      : (await this.refreshDevices(signal)).find((candidate) => candidate.serial === serial);
    if (!device) throw new HarmonyError("DEVICE_NOT_FOUND", "Harmony device is not connected", { retryable: true });
    if (device.state !== "online") throw new HarmonyError("DEVICE_OFFLINE", "Harmony device is not online or authorized", { retryable: true });
    return device;
  }

  async acquireLease(options: AcquireLeaseOptions): Promise<HarmonyLease> {
    validateSerial(options.serial);
    validateOwner(options.owner);
    const ttl = this.duration(options.ttlMs);
    return await this.enqueue("acquire_lease", async (signal) => {
      await this.onlineDevice(options.serial, signal);
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
        return renewed;
      }
      const acquiredAt = iso(this.now());
      const lease: HarmonyLease = {
        token: this.token(),
        serial: options.serial,
        owner: { ...options.owner },
        acquiredAt,
        expiresAt: iso(this.now() + ttl),
      };
      this.leasesBySerial.set(options.serial, lease);
      this.leasesByToken.set(lease.token, lease);
      this.emit({ type: "lease_acquired", timestamp: acquiredAt, lease });
      return lease;
    }, options.signal, options.owner.id, options.serial);
  }

  renewLease(token: string, ttlMs?: number): HarmonyLease {
    this.sweepExpiredLeases();
    const lease = this.leasesByToken.get(token);
    if (!lease) throw new HarmonyError("LEASE_EXPIRED", "The device lease is missing or expired", { retryable: true });
    const renewed = { ...lease, expiresAt: iso(this.now() + this.duration(ttlMs)) };
    this.leasesByToken.set(token, renewed);
    this.leasesBySerial.set(lease.serial, renewed);
    return renewed;
  }

  releaseLease(token: string): boolean {
    const lease = this.leasesByToken.get(token);
    if (!lease) return false;
    this.removeLease(lease, "released");
    return true;
  }

  releaseOwner(ownerId: string): number {
    let count = 0;
    for (const lease of [...this.leasesByToken.values()]) {
      if (lease.owner.id === ownerId) {
        this.removeLease(lease, "owner_released");
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
    validateSerial(options.serial);
    const lease = this.requireLease(options.serial, options.leaseToken);
    await this.interruptLiveFrame(options.serial, "run_scenario");
    return await this.enqueue("run_scenario", async (signal, operationId) => {
      this.requireLease(options.serial, options.leaseToken);
      const device = await this.onlineDevice(options.serial, signal);
      const result = await runHarmonyScenario({ ...options, signal }, {
        serial: options.serial,
        generation: device.generation,
        backend: this.requireBackend(),
        signal,
        now: this.now,
        capture: async (captureOptions, captureSignal) => await this.captureSnapshotNow(
          options.serial,
          captureOptions.includeTree,
          captureOptions.includeScreenshot,
          captureSignal ?? signal,
        ),
        invalidateSnapshot: () => this.snapshots.delete(options.serial),
        beforeStep: () => {
          this.requireLease(options.serial, options.leaseToken);
        },
      });
      this.emit({
        type: "operation",
        timestamp: iso(this.now()),
        serial: options.serial,
        operation: "run_scenario",
        operationId,
      });
      return result;
    }, options.signal, lease.owner.id, options.serial);
  }

  private cancelLiveFrame(serial: string, reason: string): void {
    this.liveFrameControllers.get(serial)?.abort(reason);
  }

  private async interruptLiveFrame(serial: string, reason: string): Promise<void> {
    const inFlight = this.liveFramePromises.get(serial);
    this.cancelLiveFrame(serial, reason);
    await inFlight?.catch(() => undefined);
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
    await this.onlineDevice(options.serial, options.signal);
    const backend = this.requireBackend();
    if (!backend.openVideoStream) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony video streaming is unavailable in this runtime");
    }
    return await backend.openVideoStream(options.serial, options.signal);
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
    leaseToken: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<HarmonyRecordingState> {
    validateSerial(options.serial);
    await this.interruptLiveFrame(options.serial, "start_recording");
    return await this.enqueue("start_recording", async (signal, operationId) => {
      const lease = this.requireLease(options.serial, options.leaseToken);
      if (lease.owner.id !== options.ownerId) throw new HarmonyError("LEASE_REQUIRED", "The recording owner does not hold this device lease");
      if (this.recordings.has(options.serial)) throw new HarmonyError("DEVICE_BUSY", "This Harmony device is already recording");
      const backend = this.requireBackend();
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
      await backend.startRecording(options.serial, state.remoteName, signal);
      this.recordings.set(options.serial, state);
      this.emit({ type: "operation", timestamp: iso(this.now()), serial: options.serial, operation: "start_recording", operationId });
      return { ...state };
    }, options.signal, options.ownerId, options.serial);
  }

  async stopRecording(options: {
    serial: string;
    leaseToken: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<HarmonyMediaArtifact> {
    validateSerial(options.serial);
    await this.interruptLiveFrame(options.serial, "stop_recording");
    return await this.enqueue("stop_recording", async (signal, operationId) => {
      const lease = this.requireLease(options.serial, options.leaseToken);
      if (lease.owner.id !== options.ownerId) throw new HarmonyError("LEASE_REQUIRED", "The recording owner does not hold this device lease");
      const state = this.recordings.get(options.serial);
      if (!state) throw new HarmonyError("INVALID_ARGUMENT", "This Harmony device is not recording");
      if (state.ownerId !== options.ownerId) throw new HarmonyError("DEVICE_BUSY", "The recording belongs to another controller");
      const backend = this.requireBackend();
      if (!backend.stopRecording) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony screen recording is unavailable on this device runtime");
      const destinationPath = await prepareHarmonyRecordingPath(this.config, options.serial, new Date(state.startedAt));
      await backend.stopRecording(options.serial, state.remoteName, destinationPath, signal);
      const artifact = await recordingArtifact(options.serial, destinationPath, new Date());
      this.recordings.delete(options.serial);
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
      await invoke(this.requireBackend(), queuedSignal);
      this.emit({ type: "operation", timestamp: iso(this.now()), serial, operation, operationId });
      return { serial, operationId, generation: device.generation, completedAt: iso(this.now()) };
    }, signal, lease.owner.id, serial);
  }

  async tap(options: HarmonyTapOptions): Promise<HarmonyOperationResult> {
    return await this.action("tap", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => await backend.tap(options.serial, options.x, options.y, signal));
  }

  async doubleTap(options: HarmonyPointGestureOptions): Promise<HarmonyOperationResult> {
    return await this.action("double_tap", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.doubleTap) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony double-tap injection is unavailable");
        await backend.doubleTap(options.serial, options.x, options.y, signal);
      });
  }

  async longPress(options: HarmonyPointGestureOptions): Promise<HarmonyOperationResult> {
    return await this.action("long_press", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.longPress) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony long-press injection is unavailable");
        await backend.longPress(options.serial, options.x, options.y, signal);
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
    const node = referenceSnapshot.nodeByRef.get(options.ref);
    if (!node?.bounds) throw new HarmonyError("INVALID_ARGUMENT", "UI reference does not have tappable bounds");
    if (node.enabled === false || node.visible === false) throw new HarmonyError("INVALID_ARGUMENT", "UI reference is not enabled or visible");
    if (node.clickable === false) throw new HarmonyError("INVALID_ARGUMENT", "UI reference is not clickable");
    const current = this.snapshots.get(options.serial);
    let strategy = current?.generation === options.generation && current.revision === refRevision
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
        const freshNodes = fresh.nodes ?? [];
        const exactMatches = freshNodes.filter((candidate) => isSameUiTarget(node, candidate));
        let match = exactMatches.length === 1 ? exactMatches[0] : undefined;
        if (!match) {
          const labels = [node.text, node.hint, node.description].map(normalizedLabel).filter(Boolean);
          const semanticMatches = freshNodes.filter((candidate) => {
            if (!candidate.bounds || candidate.enabled === false || candidate.visible === false || candidate.clickable === false) return false;
            if (node.type && candidate.type !== node.type) return false;
            if (node.id) return candidate.id === node.id;
            return labels.length > 0 && [candidate.text, candidate.hint, candidate.description]
              .map(normalizedLabel).some((label) => label && labels.includes(label));
          });
          if (semanticMatches.length === 1) {
            match = semanticMatches[0];
            strategy = "semantic_relaxed";
          }
        }
        const freshHasSemanticIdentity = freshNodes.some((candidate) => (
          candidate.id || candidate.text || candidate.hint || candidate.description
        ));
        if (!match && freshNodes.length > 0 && !freshHasSemanticIdentity) {
          const positionalMatches = freshNodes.filter((candidate) => {
            if (!candidate.bounds || candidate.enabled === false || candidate.visible === false || candidate.clickable === false) return false;
            if (node.type && candidate.type !== node.type) return false;
            const width = Math.max(1, node.bounds!.right - node.bounds!.left);
            const height = Math.max(1, node.bounds!.bottom - node.bounds!.top);
            return boundsDistance(node, candidate) <= Math.max(48, Math.min(width, height) * 0.75);
          });
          if (positionalMatches.length === 1) {
            match = positionalMatches[0];
            strategy = "nearby_bounds";
          }
        }
        // An empty fresh UiTest tree is an unknown device state, not evidence
        // that the old coordinates are still safe. Fail closed and require a
        // new observation rather than clicking through a system or secure UI.
        if (!match?.bounds) {
          throw new HarmonyError("STALE_SNAPSHOT", "The referenced UI target changed or became ambiguous before the tap", {
            details: { exactMatchCount: exactMatches.length, parsedNodeCount: freshNodes.length },
            retryable: true,
          });
        }
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
      async (backend, signal) => await backend.swipe(
        options.serial, options.fromX, options.fromY, options.toX, options.toY, options.durationMs, signal,
      ));
  }

  async drag(options: HarmonyDragOptions): Promise<HarmonyOperationResult> {
    return await this.action("drag", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.drag) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony drag injection is unavailable");
        await backend.drag(
          options.serial, options.fromX, options.fromY, options.toX, options.toY, options.durationMs, signal,
        );
      });
  }

  async fling(options: HarmonyFlingOptions): Promise<HarmonyOperationResult> {
    return await this.action("fling", options.serial, options.leaseToken, options.generation, options.signal,
      async (backend, signal) => {
        if (!backend.fling) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony fling injection is unavailable");
        await backend.fling(
          options.serial, options.fromX, options.fromY, options.toX, options.toY, options.durationMs, signal,
        );
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

  getConfig(): HarmonyConfig {
    return {
      ...this.config,
      ...(this.config.storage ? { storage: { ...this.config.storage } } : {}),
      ...(this.config.vision ? { vision: { ...this.config.vision } } : {}),
    };
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

  async emergencyStop(reason = "emergency_stop"): Promise<void> {
    this.queueEpoch += 1;
    this.lastDeviceRefreshAt = Number.NEGATIVE_INFINITY;
    for (const controller of this.activeControllers) controller.abort(reason);
    const deviceRefresh = this.deviceRefreshPromise;
    this.deviceRefreshController?.abort(reason);
    const liveFrames = [...this.liveFramePromises.values()];
    for (const controller of this.liveFrameControllers.values()) controller.abort(reason);
    await Promise.allSettled([...liveFrames, ...(deviceRefresh ? [deviceRefresh] : [])]);
    this.liveFrameControllers.clear();
    this.liveFramePromises.clear();
    const backend = this.backend;
    if (backend?.stopRecording && this.recordings.size > 0) {
      await Promise.all([...this.recordings.values()].map(async (recording) => {
        try {
          const destinationPath = await prepareHarmonyRecordingPath(this.config, recording.serial, new Date(recording.startedAt));
          await backend.stopRecording?.(recording.serial, recording.remoteName, destinationPath);
        } catch {
          // Emergency stop must continue releasing leases even when the device
          // disconnected before a recording could be downloaded.
        } finally {
          this.recordings.delete(recording.serial);
        }
      }));
    }
    for (const lease of [...this.leasesByToken.values()]) this.removeLease(lease, reason);
    this.snapshots.clear();
    this.referenceSnapshots.clear();
    for (const [serial, generation] of this.generations) {
      const nextGeneration = generation + 1;
      this.generations.set(serial, nextGeneration);
      const device = this.devices.get(serial);
      if (device) this.devices.set(serial, { ...device, generation: nextGeneration });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.emergencyStop("disposed");
    await Promise.allSettled([...this.operationLanes.values()].map((lane) => lane.tail));
    this.disposed = true;
    await this.backend?.dispose?.();
    this.listeners.clear();
  }
}
