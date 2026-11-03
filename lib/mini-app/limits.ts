/** Host policy. Generated plans cannot override these limits. */
export const MINI_APP_LIMITS = Object.freeze({
  planBytes: 256 * 1024,
  programBytes: 64 * 1024,
  stateBytes: 256 * 1024,
  frameBytes: 128 * 1024,
  replyBytes: 512 * 1024,
  depth: 24,
  jsonNodes: 20_000,
  documentNodes: 400,
  drawingCommands: 2_000,
  meshes: 200,
  sceneGroups: 64,
  sceneGroupDepth: 8,
  inputPresets: 16,
  triangles: 50_000,
  heapBytes: 32 * 1024 * 1024,
  wasmBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  initializationMs: 200,
  operationMs: 8,
  cpuWindowMs: 200,
  watchdogMs: 500,
  framesPerSecond: 30,
  discreteTrialSteps: 32,
  scenePickTrialEvents: 32,
  repeatRows: 50,
  repeatText: 64_000,
  repeatEvents: 128,
  repeatFrameHistory: 32,
  eventQueue: 128,
});

export const MINI_APP_RUNTIME_VERSION = "mini-app-1.1";
/** Selected only for plans using the added constant syntax; old identities stay stable. */
export const MINI_APP_CONSTANT_RUNTIME_VERSION = "mini-app-1.2";
export const MINI_APP_REPEAT_RUNTIME_VERSION = "mini-app-1.3";
export const MINI_APP_SCENE_RUNTIME_VERSION = "mini-app-1.4";
export const MINI_APP_GROUP_RUNTIME_VERSION = "mini-app-1.5";
export const MINI_APP_PRESET_RUNTIME_VERSION = "mini-app-1.6";
export const MINI_APP_MIGRATION_RUNTIME_VERSION = "mini-app-1.7";
export const MINI_APP_ACTION_RUNTIME_VERSION = "mini-app-1.8";
export const MINI_APP_CONVERSION_RUNTIME_VERSION = "mini-app-1.9";
export const MINI_APP_LEGACY_RUNTIME_VERSION = "mini-app-1.0";

export class MiniAppError extends Error {
  constructor(readonly code: string, message: string, readonly path = "", readonly repairable = false) {
    super(message);
    this.name = "MiniAppError";
  }
}

/** Class identity may change across Next hot reloads and isolated module loaders. */
export function isMiniAppError(value: unknown): value is MiniAppError {
  if (!value || typeof value !== "object") return false;
  const error = value as MiniAppError;
  return error.name === "MiniAppError" && typeof error.message === "string" && typeof error.code === "string"
    && typeof error.path === "string" && typeof error.repairable === "boolean";
}

export function miniAppError(code: string, path: string, message: string): never {
  throw new MiniAppError(code, message, path, ["SCHEMA", "BINDING", "SYNTAX", "STATE", "FRAME"].includes(code));
}
