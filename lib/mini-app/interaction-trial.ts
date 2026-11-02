import type { CompiledMiniApp, MiniAppResult } from "./plan";
import type { JsonRecord } from "./json";
import { MINI_APP_LIMITS } from "./limits";

export function miniAppPresetTrials(compiled: CompiledMiniApp): JsonRecord[] {
  return (compiled.plan.inputPresets ?? []).map(preset => ({ type: "input-preset", id: preset.id }));
}

/** Deterministic initial-frame probes, not an exhaustive interaction proof. */
export function miniAppScenePickTrials(compiled: CompiledMiniApp, initial: MiniAppResult): JsonRecord[] {
  const views = compiled.plan.viewports.filter(view => view.picking);
  const events: JsonRecord[] = [];
  for (const [index, view] of views.entries()) {
    const objects = [null, ...(initial.frame.scenes?.[view.id]?.meshes.map(mesh => mesh.id) ?? [])];
    const quota = Math.floor(MINI_APP_LIMITS.scenePickTrialEvents / views.length)
      + (index < MINI_APP_LIMITS.scenePickTrialEvents % views.length ? 1 : 0);
    const count = Math.min(objects.length, quota);
    for (let i = 0; i < count; i++) {
      // Every opted-in view includes clear and its final object; larger scenes
      // receive evenly spread samples instead of testing only a leading prefix.
      const object = objects[count === 1 ? 0 : Math.floor(i * (objects.length - 1) / (count - 1))];
      events.push({ type: "scene-pick", id: view.id, object, frame: 1 });
    }
  }
  return events;
}
