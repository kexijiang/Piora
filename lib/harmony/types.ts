export type HarmonyDeviceConnectionState =
  | "online"
  | "unauthorized"
  | "offline"
  | "unknown";

export interface HarmonyCapabilities {
  uiTree: boolean;
  screenshot: boolean;
  tap: boolean;
  swipe: boolean;
  inputText: boolean;
  keys: boolean;
  launchApp: boolean;
}

export interface HarmonyDevice {
  serial: string;
  state: HarmonyDeviceConnectionState;
  name?: string;
  model?: string;
  product?: string;
  osVersion?: string;
  apiVersion?: string;
  uitestVersion?: string;
  generation: number;
  lastSeenAt: string;
  capabilities: HarmonyCapabilities;
}

export interface HarmonyLeaseOwner {
  kind: "agent" | "manual";
  /** Unique runtime identity. Agent callers should use their run/session identity. */
  id: string;
  sessionId?: string;
}

export interface HarmonyLease {
  token: string;
  serial: string;
  owner: HarmonyLeaseOwner;
  acquiredAt: string;
  expiresAt: string;
}

export interface HarmonyBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HarmonyUiNode {
  ref: string;
  parentRef?: string;
  text?: string;
  id?: string;
  type?: string;
  hint?: string;
  description?: string;
  bounds?: HarmonyBounds;
  enabled?: boolean;
  clickable?: boolean;
  scrollable?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  visible?: boolean;
}

export interface HarmonyScreenshot {
  mimeType: "image/png";
  data: Buffer;
  width?: number;
  height?: number;
}

export interface HarmonyProcess {
  pid: number;
  name: string;
}

export type HarmonyLogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export interface HarmonyLogEntry {
  timestamp?: string;
  level: HarmonyLogLevel;
  pid?: number;
  tid?: number;
  domain?: string;
  tag?: string;
  message: string;
  raw: string;
}

export interface HarmonyLogOptions {
  serial: string;
  pid?: number;
  level?: Exclude<HarmonyLogLevel, "unknown">;
  query?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface HarmonySnapshot {
  serial: string;
  generation: number;
  revision: number;
  capturedAt: string;
  tree?: unknown;
  nodes?: HarmonyUiNode[];
  screenshot?: HarmonyScreenshot;
}

export interface HarmonyManagerState {
  runtime: {
    status: "unresolved" | "ready" | "unavailable" | "error";
    hdcPath?: string;
    error?: ReturnType<import("./errors").HarmonyError["toJSON"]>;
  };
  devices: HarmonyDevice[];
  leases: HarmonyLease[];
  snapshots: Array<{
    serial: string;
    generation: number;
    revision: number;
    capturedAt: string;
    hasTree: boolean;
    hasScreenshot: boolean;
  }>;
}

export interface HarmonyConfig {
  hdcPath?: string;
  storage?: {
    screenshotDirectory?: string;
    recordingDirectory?: string;
  };
  vision?: {
    enabled: boolean;
    provider: string;
    modelId: string;
    /** Keep the raw phone screenshot out of the action model by default. */
    shareScreenshotWithActionModel?: boolean;
  };
}

export interface HarmonyMediaArtifact {
  kind: "screenshot" | "recording";
  serial: string;
  path: string;
  filename: string;
  createdAt: string;
  size: number;
  mimeType: "image/png" | "video/mp4";
}

export interface HarmonyRecordingState {
  serial: string;
  recordingId: string;
  remoteName: string;
  startedAt: string;
  ownerId: string;
}

export interface HarmonyRuntimeCandidate {
  hdcPath: string;
  sdkPath: string;
  source: "selection" | "environment" | "config" | "deveco" | "path" | "bundled";
}

export interface HarmonyVideoConnection {
  stream: ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface HarmonyDiagnostics {
  timestamp: string;
  config: HarmonyConfig;
  runtime: HarmonyManagerState["runtime"] & { backendKind?: string };
  deviceCount: number;
  onlineDeviceCount: number;
  activeLeaseCount: number;
  queue: { pending: number; active: boolean; epoch: number };
  automation?: {
    provider: string;
    sessions: Array<{ serial: string; state: "idle" | "connecting" | "ready" | "cooldown"; retryAt?: string }>;
  };
}

export interface HarmonyOperationResult {
  serial: string;
  operationId: number;
  generation: number;
  completedAt: string;
  strategy?: string;
  x?: number;
  y?: number;
}

export interface HarmonySnapshotOptions {
  serial: string;
  leaseToken?: string;
  includeTree?: boolean;
  includeScreenshot?: boolean;
  signal?: AbortSignal;
}

export interface HarmonyTapOptions {
  serial: string;
  leaseToken: string;
  x: number;
  y: number;
  generation?: number;
  signal?: AbortSignal;
}

export type HarmonyPointGestureOptions = HarmonyTapOptions;

export interface HarmonyTapRefOptions {
  serial: string;
  leaseToken: string;
  ref: string;
  generation: number;
  signal?: AbortSignal;
}

export interface HarmonySwipeOptions {
  serial: string;
  leaseToken: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
  generation?: number;
  signal?: AbortSignal;
}

export type HarmonyDragOptions = HarmonySwipeOptions;

export type HarmonyFlingOptions = HarmonySwipeOptions;

export interface HarmonyInputTextOptions {
  serial: string;
  leaseToken: string;
  text: string;
  signal?: AbortSignal;
}

export interface HarmonyPressKeyOptions {
  serial: string;
  leaseToken: string;
  key: "back" | "home" | "recents" | "enter";
  signal?: AbortSignal;
}

export interface HarmonyLaunchAppOptions {
  serial: string;
  leaseToken: string;
  bundleName: string;
  abilityName?: string;
  signal?: AbortSignal;
}

export interface HarmonyInstallAppOptions {
  serial: string;
  leaseToken: string;
  hapPath: string;
  replace?: boolean;
  signal?: AbortSignal;
}

export type HarmonySelectorMatch = "exact" | "contains" | "starts_with" | "ends_with";

/** Stable, model-friendly description of a UI target. Pixel coordinates are deliberately excluded. */
export interface HarmonyUiSelector {
  id?: string;
  text?: string;
  type?: string;
  hint?: string;
  description?: string;
  match?: HarmonySelectorMatch;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  visible?: boolean;
  inWindow?: string;
  within?: HarmonyUiSelector;
  before?: HarmonyUiSelector;
  after?: HarmonyUiSelector;
  /** Zero-based disambiguation for selectors that intentionally match more than one element. */
  index?: number;
}

export interface HarmonyWaitCondition {
  selector: HarmonyUiSelector;
  exists?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

export type HarmonyScenarioStep =
  | { id?: string; action: "tap" | "double_tap" | "long_press"; selector: HarmonyUiSelector; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "input_text"; selector: HarmonyUiSelector; text: string; append?: boolean; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "clear_text"; selector: HarmonyUiSelector; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "scroll_find"; selector: HarmonyUiSelector; container?: HarmonyUiSelector; direction?: "up" | "down"; maxSwipes?: number; tap?: boolean; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "swipe" | "fling"; direction: "left" | "right" | "up" | "down"; durationMs?: number; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "press_key"; key: "back" | "home" | "recents" | "enter"; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "launch_app"; bundleName: string; abilityName?: string; waitFor?: HarmonyWaitCondition }
  | { id?: string; action: "stop_app" | "clear_app_data" | "uninstall_app"; bundleName: string }
  | { id?: string; action: "install_app"; hapPath: string; replace?: boolean }
  | { id?: string; action: "wait_for" | "assert"; condition: HarmonyWaitCondition }
  | { id?: string; action: "wait_idle"; idleMs?: number; timeoutMs?: number }
  | { id?: string; action: "checkpoint"; name: string };

export interface HarmonyScenarioPolicy {
  defaultTimeoutMs?: number;
  defaultIntervalMs?: number;
  settleAfterAction?: boolean;
  captureFinalScreenshot?: boolean;
}

export interface HarmonyScenarioOptions {
  serial: string;
  leaseToken: string;
  steps: HarmonyScenarioStep[];
  policy?: HarmonyScenarioPolicy;
  signal?: AbortSignal;
}

export interface HarmonyScenarioStepResult {
  index: number;
  id?: string;
  action: HarmonyScenarioStep["action"];
  status: "passed" | "failed";
  durationMs: number;
  strategy?: string;
  message?: string;
}

export interface HarmonyScenarioResult {
  serial: string;
  generation: number;
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  completedSteps: number;
  checkpoint?: { name: string; stepIndex: number };
  steps: HarmonyScenarioStepResult[];
  finalSnapshot?: HarmonySnapshot;
}

export interface HarmonySemanticActionRequest {
  action: "tap" | "double_tap" | "long_press" | "input_text" | "clear_text" | "scroll_find";
  selector: HarmonyUiSelector;
  text?: string;
  append?: boolean;
  container?: HarmonyUiSelector;
  tapAfterScroll?: boolean;
  timeoutMs?: number;
}

export interface HarmonySemanticActionResult {
  strategy: string;
}

export type HarmonyManagerEvent =
  | { type: "state"; timestamp: string; state: HarmonyManagerState }
  | { type: "devices"; timestamp: string; devices: HarmonyDevice[] }
  | { type: "lease_acquired"; timestamp: string; lease: HarmonyLease }
  | { type: "lease_released"; timestamp: string; serial: string; ownerId: string; reason: string }
  | { type: "snapshot"; timestamp: string; serial: string; generation: number; revision: number }
  | { type: "operation"; timestamp: string; serial: string; operation: string; operationId: number };

export interface BackendDevice {
  serial: string;
  state: HarmonyDeviceConnectionState;
  name?: string;
  model?: string;
  product?: string;
  osVersion?: string;
  apiVersion?: string;
  uitestVersion?: string;
  capabilities: HarmonyCapabilities;
}

export interface BackendSnapshot {
  tree?: unknown;
  nodes?: Array<Omit<HarmonyUiNode, "ref" | "parentRef"> & { parentIndex?: number }>;
  screenshot?: HarmonyScreenshot;
}

export interface HarmonyAutomationBackend {
  readonly kind: string;
  readonly hdcPath?: string;
  listDevices(signal?: AbortSignal): Promise<BackendDevice[]>;
  listProcesses?(serial: string, signal?: AbortSignal): Promise<HarmonyProcess[]>;
  streamLogs?(serial: string, onEntries: (entries: HarmonyLogEntry[]) => void, signal?: AbortSignal): Promise<void>;
  readLogs?(
    serial: string,
    options: Omit<HarmonyLogOptions, "serial" | "signal"> & { signal?: AbortSignal },
  ): Promise<HarmonyLogEntry[]>;
  snapshot(
    serial: string,
    options: { includeTree: boolean; includeScreenshot: boolean; signal?: AbortSignal },
  ): Promise<BackendSnapshot>;
  startRecording?(serial: string, remoteName: string, signal?: AbortSignal): Promise<void>;
  stopRecording?(serial: string, remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<number>;
  openVideoStream?(serial: string, signal?: AbortSignal): Promise<HarmonyVideoConnection>;
  tap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void>;
  doubleTap?(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void>;
  longPress?(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void>;
  swipe(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  drag?(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  fling?(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  inputText(serial: string, text: string, signal?: AbortSignal): Promise<void>;
  pressKey(
    serial: string,
    key: "back" | "home" | "recents" | "enter",
    signal?: AbortSignal,
  ): Promise<void>;
  launchApp(
    serial: string,
    bundleName: string,
    abilityName?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  installPackage?(serial: string, hapPath: string, replace?: boolean, signal?: AbortSignal): Promise<void>;
  stopApp?(serial: string, bundleName: string, signal?: AbortSignal): Promise<void>;
  clearAppData?(serial: string, bundleName: string, signal?: AbortSignal): Promise<void>;
  uninstallPackage?(serial: string, bundleName: string, signal?: AbortSignal): Promise<void>;
  waitForIdle?(serial: string, idleMs: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  semanticAction?(
    serial: string,
    request: HarmonySemanticActionRequest,
    signal?: AbortSignal,
  ): Promise<HarmonySemanticActionResult>;
  resetAutomation?(serial?: string): Promise<void>;
  automationDiagnostics?(): NonNullable<HarmonyDiagnostics["automation"]>;
  dispose?(): Promise<void> | void;
}
