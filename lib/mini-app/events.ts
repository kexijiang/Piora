import { boundedJson, exactKeys, jsonRecord, type JsonRecord } from "./json";
import { miniAppError } from "./limits";
import { validateMiniAppInputs, type CompiledMiniApp } from "./plan";
import type { MiniAppCheckpoint, MiniAppVmRequest } from "./vm";
import { miniAppStepRequest } from "./playback";
import type { MiniAppFrame } from "./frame";
import { validateMiniAppRepeatField } from "./repeat";

/** Local interaction only. File/tool actions are never accepted from a frame. */
export function miniAppEventRequest(compiled: CompiledMiniApp, snapshot: MiniAppCheckpoint, value: unknown, frame?: MiniAppFrame): MiniAppVmRequest {
  boundedJson(value, 8000, "event");
  const event = jsonRecord(value, "event"), type = event.type;
  if (type === "blur") {
    exactKeys(event, ["type"], "event");
    return { command: "event", snapshot, event: { type } };
  }
  if (typeof event.id !== "string") miniAppError("BINDING", "event/id", "Event requires a declared target");
  if (type === "input-preset") {
    exactKeys(event, ["type", "id"], "event");
    const preset = compiled.plan.inputPresets?.find(preset => preset.id === event.id);
    if (!preset || !compiled.document.presets?.includes(preset.id)) miniAppError("BINDING", "event/id", "Unknown input preset button");
    const inputs = validateMiniAppInputs(compiled.plan, { ...snapshot.inputs, ...preset.values });
    const values = Object.fromEntries(compiled.plan.inputs.filter(input => Object.hasOwn(preset.values, input.id)).map(input => [input.id, inputs[input.id]]));
    return { command: "preset", snapshot: { ...snapshot, inputs }, event: { type, id: preset.id, values } };
  }
  if (type === "scene-pick") {
    exactKeys(event, ["type", "id", "object", "frame", "serial"], "event");
    if (event.serial !== undefined && (!Number.isSafeInteger(event.serial) || (event.serial as number) < 1)) miniAppError("BINDING", "event/serial", "Selection sequence must be a positive safe integer");
    const viewport = compiled.plan.viewports.find(view => view.id === event.id && view.picking);
    if (!viewport || !Number.isSafeInteger(event.frame) || (event.frame as number) < 1
      || event.object !== null && (typeof event.object !== "string" || !frame?.scenes?.[viewport.id]?.meshes.some(mesh => mesh.id === event.object))) miniAppError("BINDING", "event/object", "Selection must reference an object in a declared scene frame");
    return { command: "event", snapshot, event: { type, id: viewport.id, object: event.object as string | null } };
  }
  if (type === "item-input" || type === "item-click") {
    exactKeys(event, ["type", "id", "repeat", "key", "frame", "serial", ...(type === "item-input" ? ["value"] : [])], "event");
    const definition = compiled.document.repeats?.find(item => item.id === event.repeat);
    if (!definition || typeof event.key !== "string" || !frame?.repeats?.[definition.id]?.some(row => row.key === event.key)) miniAppError("BINDING", "event/key", "Unknown row identity");
    if (!Number.isSafeInteger(event.frame) || !Number.isSafeInteger(event.serial) || (event.serial as number) < 1) miniAppError("BINDING", "event/frame", "Row interaction requires host frame and serial identities");
    const checked: JsonRecord = { type, id: event.id, repeat: definition.id, key: event.key };
    if (type === "item-input") {
      const field = definition.fields.find(field => field.id === event.id);
      if (!field) miniAppError("BINDING", "event/id", "Unknown row field");
      checked.value = validateMiniAppRepeatField(field, event.value, "event/value");
    } else if (!definition.events.includes(event.id)) miniAppError("BINDING", "event/id", "Unknown row action");
    return { command: "event", snapshot, event: checked };
  }
  if (type === "input") {
    exactKeys(event, ["type", "id", "value", "serial"], "event");
    if (event.serial !== undefined && (!Number.isSafeInteger(event.serial) || (event.serial as number) < 1)) miniAppError("BINDING", "event/serial", "Input sequence must be a positive safe integer");
    if (!compiled.plan.inputs.some(i => i.id === event.id)) miniAppError("BINDING", "event/id", "Unknown input");
    const inputs = validateMiniAppInputs(compiled.plan, { ...snapshot.inputs, [event.id]: event.value });
    return { command: "event", snapshot: { ...snapshot, inputs }, event: { type, id: event.id, value: inputs[event.id] } };
  }
  if (!compiled.document.events.includes(event.id)) miniAppError("BINDING", "event/id", "Unknown interaction target");
  let checked: JsonRecord;
  if (type === "click") {
    exactKeys(event, ["type", "id"], "event"); checked = { type, id: event.id };
    if (compiled.plan.playback?.mode === "discrete" && compiled.plan.playback.stepEvent === event.id) return miniAppStepRequest(compiled, snapshot)!;
  } else if (type === "keydown" || type === "keyup") {
    exactKeys(event, ["type", "id", "key", "repeat"], "event");
    if (typeof event.key !== "string" || !event.key || event.key.length > 32 || typeof event.repeat !== "boolean") miniAppError("SCHEMA", "event/key", "Invalid keyboard event");
    checked = { type, id: event.id, key: event.key, repeat: event.repeat };
  } else if (["pointerdown", "pointermove", "pointerup", "pointercancel"].includes(String(type))) {
    exactKeys(event, ["type", "id", "x", "y", "buttons"], "event");
    if ([event.x, event.y].some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 100_000)
      || !Number.isInteger(event.buttons) || (event.buttons as number) < 0 || (event.buttons as number) > 31) miniAppError("SCHEMA", "event", "Invalid pointer coordinates or buttons");
    checked = { type: type as string, id: event.id, x: event.x as number, y: event.y as number, buttons: event.buttons as number };
  } else miniAppError("SCHEMA", "event/type", "Unsupported local event");
  return { command: "event", snapshot, event: checked };
}
