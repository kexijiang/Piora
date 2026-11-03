import { boundedJson, exactKeys, jsonRecord, type JsonRecord } from "./json";
import { miniAppError, MiniAppError } from "./limits";
import { MiniAppRepeatIdentity } from "./repeat";
import type { MiniAppFrame, MiniAppViewport } from "./frame";

export type Vector3 = [number, number, number];
export interface MiniAppCamera { position: Vector3; target: Vector3; fov: number }
export interface MiniAppCameraState { reset: number; camera: MiniAppCamera }
/** Host view state never enters generated lifecycle functions or task state. */
export interface MiniAppViewState { version: 1; cameras: Record<string, MiniAppCameraState> }

export function validateMiniAppCamera(value: unknown, path = "camera"): MiniAppCamera {
  const c = jsonRecord(value, path); exactKeys(c, ["position", "target", "fov"], path);
  const vector = (value: unknown, key: string): Vector3 => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 10_000)) miniAppError("FRAME", `${path}/${key}`, "Expected a bounded finite camera vector");
    return [...value] as Vector3;
  };
  const position = vector(c.position, "position"), target = vector(c.target, "target");
  const distance = Math.hypot(...position.map((n, i) => n - target[i]));
  // Orbit transforms introduce round-off at exact zoom limits.
  if (distance < 0.05 - 1e-9 || distance > 10_000 + 1e-9) miniAppError("FRAME", path, "Camera distance must be between 0.05 and 10000");
  if (typeof c.fov !== "number" || !Number.isFinite(c.fov) || c.fov < 15 || c.fov > 90) miniAppError("FRAME", `${path}/fov`, "Camera field of view must be between 15 and 90 degrees");
  return { position, target, fov: c.fov };
}

export function miniAppCameraReset(value: unknown, path = "cameraRevision"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) miniAppError("FRAME", path, "Expected a nonnegative camera revision");
  return value as number;
}

export function validateMiniAppViewState(value: unknown, viewports: readonly MiniAppViewport[]): MiniAppViewState | undefined {
  if (value === undefined) return undefined;
  boundedJson(value, 8000, "view");
  const v = jsonRecord(value, "view"); exactKeys(v, ["version", "cameras"], "view");
  if (v.version !== 1) miniAppError("STATE", "view/version", "Unsupported view state version");
  const cameras: MiniAppViewState["cameras"] = {};
  for (const [id, raw] of Object.entries(jsonRecord(v.cameras, "view/cameras"))) {
    if (!viewports.some(view => view.id === id && view.kind === "scene3d" && view.cameraControls)) miniAppError("STATE", `view/cameras/${id}`, "Camera controls are not declared for this viewport");
    const item = jsonRecord(raw, `view/cameras/${id}`); exactKeys(item, ["reset", "camera"], `view/cameras/${id}`);
    cameras[id] = { reset: miniAppCameraReset(item.reset), camera: validateMiniAppCamera(item.camera) };
  }
  return { version: 1, cameras };
}

/** Program resets invalidate just the affected camera, ordinary projections preserve it. */
export function reconcileMiniAppView(view: MiniAppViewState | undefined, frame: MiniAppFrame): MiniAppViewState | undefined {
  if (!view) return undefined;
  return { version: 1, cameras: Object.fromEntries(Object.entries(view.cameras).filter(([id, camera]) => frame.scenes?.[id] && camera.reset === (frame.scenes[id].cameraRevision ?? 0))) };
}

/** Saved selection and observation angle, never a substitute for task geometry. */
export function miniAppSceneContext(frame: MiniAppFrame, view: MiniAppViewState | undefined) {
  const distance = (camera: MiniAppCamera) => Math.hypot(...camera.position.map((value, index) => value - camera.target[index]));
  const scenes = Object.entries(frame.scenes ?? {}).map(([id, scene]) => ({
    id, selected: scene.selected ? { id: scene.selected, label: scene.meshes.find(mesh => mesh.id === scene.selected)?.label ?? scene.selected } : null,
    camera: view?.cameras[id]?.camera ?? scene.camera, cameraSource: view?.cameras[id] ? "saved-user-view" : "program-default",
    cameraMetrics: { units: "scene-units", distanceToTarget: distance(view?.cameras[id]?.camera ?? scene.camera),
      programDefaultDistanceToTarget: distance(scene.camera), scope: "current-view-versus-current-program-default-not-history" },
  }));
  return scenes.length ? scenes : undefined;
}

/** Reuse the bounded stable-entity generation tracker used by keyed rows. */
export class MiniAppSceneIdentity {
  private readonly entities = new MiniAppRepeatIdentity();
  private revision = 0;
  publish(scenes: MiniAppFrame["scenes"]): number {
    this.revision = this.entities.publish(Object.fromEntries(Object.entries(scenes ?? {}).map(([id, scene]) => [id, scene.meshes.map(mesh => ({ key: mesh.id, bindings: {} }))])));
    return this.revision;
  }
  validate(event: JsonRecord): void {
    if (event.object === null) {
      if (event.frame !== this.revision) throw new MiniAppError("STALE_EVENT", "The scene selection belongs to an old frame");
    } else this.entities.validate({ repeat: event.id, key: event.object, frame: event.frame });
  }
  reset(): void { this.entities.reset(); }
}
