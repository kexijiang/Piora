import { boundedJson, exactKeys, jsonRecord, readId, type JsonRecord } from "./json";
import { MINI_APP_LIMITS, MINI_APP_RUNTIME_VERSION, MINI_APP_LEGACY_RUNTIME_VERSION, MINI_APP_CONSTANT_RUNTIME_VERSION, MiniAppError, isMiniAppError, miniAppError } from "./limits";
import { compileMiniAppPlayback, type MiniAppPlayback } from "./playback";
import { compileMiniAppDocument, type MiniAppDocument, type MiniAppDocumentNode } from "./document";
import { compileMiniAppProgram } from "./program";
import { compileMiniAppStateSchema, validateMiniAppState, type MiniAppStateSchema } from "./state-schema";
import { validateMiniAppFrame, type MiniAppFrame, type MiniAppViewport } from "./frame";
import type { MiniAppCheckpoint, MiniAppVmReply } from "./vm";
import { validateUiActions, type UiActionDeclaration } from "../intelligent-ui/action-contract";
import { MINI_APP_REPEAT_RUNTIME_VERSION, MINI_APP_SCENE_RUNTIME_VERSION, MINI_APP_GROUP_RUNTIME_VERSION, MINI_APP_PRESET_RUNTIME_VERSION, MINI_APP_MIGRATION_RUNTIME_VERSION, MINI_APP_ACTION_RUNTIME_VERSION } from "./limits";
import { validateMiniAppViewState, reconcileMiniAppView } from "./scene-state";
import { parseAnswerConversionSpec, type AnswerConversionSpec } from "../answer-output-conversion-types";
import { MINI_APP_CONVERSION_RUNTIME_VERSION } from "./limits";
import { compileA2uiMiniDocument, recompileA2uiMiniDocument } from "../a2ui/mini-document";
import type { A2uiDocument } from "../a2ui/document";

interface InputBase { id: string; label: string; meaning: string }
export type MiniAppInput = InputBase & (
  | { type: "number" | "range"; value: number; min: number; max: number; step: number }
  | { type: "checkbox"; value: boolean }
  | { type: "text"; value: string; maxLength: number }
  | { type: "select"; value: string; options: Array<{ value: string; label: string }> }
);
export interface MiniAppInputPreset { id: string; label: string; values: JsonRecord }
export interface MiniAppProgressMigration { fromPlanDigest: string; description: string; clock: "reset" | "preserve" }
export interface MiniAppPlan1 {
  planVersion: 1; id: string; title: string; purpose: string; assumptions: string[];
  inputs: MiniAppInput[]; stateSchema: MiniAppStateSchema;
  document: { html: string; css: string; a2ui?: A2uiDocument }; viewports: MiniAppViewport[];
  program: string; initialSnapshot: string; actions?: UiActionDeclaration;
  playback?: MiniAppPlayback;
  inputPresets?: MiniAppInputPreset[];
  migration?: MiniAppProgressMigration;
  conversion?: AnswerConversionSpec;
}
export interface CompiledMiniApp {
  plan: MiniAppPlan1; document: MiniAppDocument; initialInputs: JsonRecord; runtimeVersion: string;
}
export interface MiniAppResult { snapshot: MiniAppCheckpoint; frame: MiniAppFrame }

class MiniAppPlanError extends MiniAppError {
  constructor(readonly issues: MiniAppError[], repairable: boolean) {
    const first = issues[0];
    super(first.code, first.message, first.path, repairable);
  }
}

function text(value: unknown, path: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) miniAppError("SCHEMA", path, `Expected ${empty ? "" : "nonempty "}text of at most ${max} characters`);
  return value;
}
function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) miniAppError("SCHEMA", path, `Expected a finite number between ${min} and ${max}`);
  return value;
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) miniAppError("SCHEMA", path, `Expected at most ${max} entries`);
  return value;
}
function input(value: unknown, path: string): MiniAppInput {
  const v = jsonRecord(value, path), base = { id: readId(v.id, `${path}/id`), label: text(v.label, `${path}/label`, 120), meaning: text(v.meaning, `${path}/meaning`, 300) };
  const common = ["id", "label", "meaning", "type", "value"];
  if (v.type === "checkbox") {
    exactKeys(v, common, path);
    if (typeof v.value !== "boolean") miniAppError("SCHEMA", path, "Checkbox value must be boolean");
    return { ...base, type: "checkbox", value: v.value };
  }
  if (v.type === "number" || v.type === "range") {
    exactKeys(v, [...common, "min", "max", "step"], path);
    const min = number(v.min, `${path}/min`, -1e12, 1e12), max = number(v.max, `${path}/max`, min, 1e12);
    return { ...base, type: v.type, min, max, step: number(v.step, `${path}/step`, 1e-9, 1e12), value: number(v.value, `${path}/value`, min, max) };
  }
  if (v.type === "text") {
    exactKeys(v, [...common, "maxLength"], path);
    const maxLength = number(v.maxLength, `${path}/maxLength`, 1, 2000);
    if (!Number.isInteger(maxLength)) miniAppError("SCHEMA", path, "maxLength must be an integer");
    return { ...base, type: "text", maxLength, value: text(v.value, `${path}/value`, maxLength, true) };
  }
  if (v.type !== "select") miniAppError("SCHEMA", path, "Unsupported input type");
  exactKeys(v, [...common, "options"], path);
  const options = array(v.options, `${path}/options`, 32).map((value, i) => {
    const p = `${path}/options/${i}`, option = jsonRecord(value, p); exactKeys(option, ["value", "label"], p);
    return { value: text(option.value, `${p}/value`, 120), label: text(option.label, `${p}/label`, 120) };
  });
  if (!options.length || new Set(options.map(o => o.value)).size !== options.length || !options.some(o => o.value === v.value)) miniAppError("SCHEMA", path, "Select value must match one unique option");
  return { ...base, type: "select", value: v.value as string, options };
}

/** Bind authoritative control constraints; markup cannot silently redefine input meaning. */
function bindInputs(document: MiniAppDocument, inputs: MiniAppInput[], presets?: MiniAppInputPreset[]): void {
  const walk = (node: MiniAppDocumentNode): void => {
    if (node.type !== "element") return;
    const id = node.attrs["data-input"];
    if (id) {
      const input = inputs.find(i => i.id === id)!;
      if ((input.type === "select" ? "select" : "input") !== node.tag) miniAppError("BINDING", `document/${id}`, "Control tag does not match its declared input type");
      if (node.attrs.type && node.attrs.type !== input.type) miniAppError("BINDING", `document/${id}`, "Control type does not match its input definition");
      if (["value", "checked", "disabled", "min", "max", "step"].some(key => Object.hasOwn(node.attrs, key))) miniAppError("BINDING", `document/${id}`, "Input values and constraints belong in the input definition");
      node.attrs["aria-label"] = input.label;
      if (input.type === "select") {
        node.children = input.options.map(option => ({ type: "element", tag: "option", svg: false, attrs: { value: option.value }, children: [{ type: "text", text: option.label }] }));
      } else {
        node.attrs.type = input.type;
        if (input.type === "number" || input.type === "range") Object.assign(node.attrs, { min: String(input.min), max: String(input.max), step: String(input.step) });
        if (input.type === "text") node.attrs.maxlength = String(input.maxLength);
      }
    }
    const presetId = node.attrs["data-preset"];
    if (presetId) {
      const preset = presets!.find(preset => preset.id === presetId)!;
      node.attrs.type = "button"; node.attrs["aria-label"] = preset.label;
      node.children = [{ type: "text", text: preset.label }];
    }
    node.children.forEach(walk);
  };
  document.nodes.forEach(walk);
  let count = 0;
  const budget = (node: MiniAppDocumentNode): void => {
    if (++count > MINI_APP_LIMITS.documentNodes) miniAppError("LIMIT", "document", "Expanded controls exceed the document node budget");
    if (node.type === "element") node.children.forEach(budget);
  };
  document.nodes.forEach(budget);
}

export function compileMiniAppPlan(value: unknown): CompiledMiniApp {
  boundedJson(value, MINI_APP_LIMITS.planBytes, "plan");
  const v = jsonRecord(value, "plan");
  exactKeys(v, ["planVersion", "id", "title", "purpose", "assumptions", "inputs", "stateSchema", "document", "viewports", "program", "initialSnapshot", "actions", "playback", "inputPresets", "migration", "conversion"], "plan");
  if (v.planVersion !== 1) miniAppError("SCHEMA", "planVersion", "Expected MiniAppPlan version 1");
  const issues: MiniAppError[] = [];
  let repairable = true;
  const check = <T>(validate: () => T): T | undefined => {
    try { return validate(); }
    catch (error) {
      if (!isMiniAppError(error)) throw error;
      repairable &&= error.repairable;
      if (issues.length < 8) issues.push(error);
      return undefined;
    }
  };
  const id = check(() => readId(v.id, "id"));
  const title = check(() => text(v.title, "title", 160));
  const purpose = check(() => text(v.purpose, "purpose", 600));
  const assumptions = check(() => array(v.assumptions, "assumptions", 12).map((v, i) => text(v, `assumptions/${i}`, 300)));
  const initialSnapshot = check(() => text(v.initialSnapshot, "initialSnapshot", 4000));
  const stateSchema = check(() => compileMiniAppStateSchema(v.stateSchema));
  const inputs = check(() => {
    const parsed = array(v.inputs, "inputs", 24).map((v, i) => input(v, `inputs/${i}`));
    if (new Set(parsed.map(i => i.id)).size !== parsed.length) miniAppError("BINDING", "inputs", "Input ids must be unique");
    return parsed;
  });
  const inputPresets = v.inputPresets === undefined || !inputs ? undefined : check(() => {
    const presets = array(v.inputPresets, "inputPresets", MINI_APP_LIMITS.inputPresets).map((value, index): MiniAppInputPreset => {
      const p = `inputPresets/${index}`, preset = jsonRecord(value, p); exactKeys(preset, ["id", "label", "values"], p);
      const values = jsonRecord(preset.values, `${p}/values`);
      if (!Object.keys(values).length) miniAppError("SCHEMA", `${p}/values`, "A preset must set at least one declared input");
      const checked = validateMiniAppInputs({ inputs }, { ...Object.fromEntries(inputs.map(input => [input.id, input.value])), ...values });
      return { id: readId(preset.id, `${p}/id`), label: text(preset.label, `${p}/label`, 120),
        values: Object.fromEntries(inputs.filter(input => Object.hasOwn(values, input.id)).map(input => [input.id, checked[input.id]])) };
    });
    if (!presets.length || new Set(presets.map(preset => preset.id)).size !== presets.length) miniAppError("BINDING", "inputPresets", "Declare 1 to 16 uniquely named input presets");
    return presets;
  });
  const viewports = check(() => {
    const parsed = array(v.viewports, "viewports", 3).map((value, i): MiniAppViewport => {
    const p = `viewports/${i}`, view = jsonRecord(value, p); exactKeys(view, ["id", "kind", "label", "width", "height", "picking", "cameraControls", "groups"], p);
    if (view.kind !== "canvas2d" && view.kind !== "scene3d") miniAppError("SCHEMA", p, "Expected canvas2d or scene3d viewport");
    const width = number(view.width, `${p}/width`, 32, 1024), height = number(view.height, `${p}/height`, 32, 1024);
    if (!Number.isInteger(width) || !Number.isInteger(height)) miniAppError("SCHEMA", p, "Viewport dimensions must be integers");
    for (const flag of ["picking", "cameraControls", "groups"]) if (view[flag] !== undefined && (view.kind !== "scene3d" || view[flag] !== true)) miniAppError("SCHEMA", `${p}/${flag}`, "This opt-in requires true on a scene3d viewport");
    return { id: readId(view.id, `${p}/id`), kind: view.kind, label: text(view.label, `${p}/label`, 160), width, height,
      ...(view.picking ? { picking: true as const } : {}), ...(view.cameraControls ? { cameraControls: true as const } : {}), ...(view.groups ? { groups: true as const } : {}) };
    });
    if (new Set(parsed.map(i => i.id)).size !== parsed.length) miniAppError("BINDING", "viewports", "Viewport ids must be unique");
    return parsed;
  });
  const documentSource = check(() => {
    const source = jsonRecord(v.document, "document");
    if ("messages" in source || "a2ui" in source) {
      exactKeys(source, "messages" in source ? ["messages"] : ["html", "css", "a2ui"], "document");
      if (!id || !inputs || !viewports) miniAppError("BINDING", "document", "Valid identity, inputs and viewports are required before compiling A2UI");
      const options = { id, inputs, viewports, presets: inputPresets };
      const compiled = "messages" in source ? compileA2uiMiniDocument(source.messages, options) : recompileA2uiMiniDocument(source.a2ui as A2uiDocument, options);
      if ("a2ui" in source && (source.html !== compiled.html || source.css !== compiled.css)) miniAppError("BINDING", "document", "Saved A2UI does not match its native projection");
      return compiled;
    }
    exactKeys(source, ["html", "css"], "document");
    return { html: text(source.html, "document/html", 64_000), css: text(source.css, "document/css", 24_000, true) };
  });
  const document = inputs && viewports && documentSource ? check(() => {
    const parsed = compileMiniAppDocument(documentSource, { inputs: inputs.map(i => i.id), viewports: viewports.map(i => i.id), presets: inputPresets?.map(preset => preset.id) });
    bindInputs(parsed, inputs, inputPresets);
    return parsed;
  }) : undefined;
  const playback = document ? check(() => compileMiniAppPlayback(v.playback, document)) : undefined;
  const migration = v.migration === undefined ? undefined : check((): MiniAppProgressMigration => {
    const value = jsonRecord(v.migration, "migration"); exactKeys(value, ["fromPlanDigest", "description", "clock"], "migration");
    if (typeof value.fromPlanDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.fromPlanDigest)) miniAppError("SCHEMA", "migration/fromPlanDigest", "Expected the exact source program digest");
    if (value.clock !== "reset" && value.clock !== "preserve") miniAppError("SCHEMA", "migration/clock", "Choose reset or preserve for logical clock and RNG");
    return { fromPlanDigest: value.fromPlanDigest, description: text(value.description, "migration/description", 600), clock: value.clock };
  });
  const program = check(() => {
    const source = text(v.program, "program", MINI_APP_LIMITS.programBytes);
    return { source, ...compileMiniAppProgram(source, !!migration) };
  });
  const actions = v.actions === undefined ? undefined : check(() => validateUiActions(v.actions));
  const conversion = v.conversion === undefined ? undefined : check(() => {
    if (migration) throw new MiniAppError("SCHEMA", "Cross-form conversion starts fresh progress; do not combine it with same-app progress migration", "conversion");
    try { return parseAnswerConversionSpec(v.conversion, "mini-app"); }
    catch (error) { throw new MiniAppError("SCHEMA", error instanceof Error ? error.message : "Invalid conversion", "conversion", true); }
  });
  if (issues.length) throw new MiniAppPlanError(issues, repairable);
  const plan: MiniAppPlan1 = { planVersion: 1, id: id!, title: title!, purpose: purpose!, assumptions: assumptions!, inputs: inputs!,
    stateSchema: stateSchema!, document: documentSource!, viewports: viewports!, program: program!.source,
    initialSnapshot: initialSnapshot!, ...(playback ? { playback } : {}), ...(actions ? { actions } : {}), ...(inputPresets ? { inputPresets } : {}), ...(migration ? { migration } : {}), ...(conversion ? { conversion } : {}) };
  return { plan, document: document!, initialInputs: Object.fromEntries(inputs!.map(i => [i.id, i.value])),
    runtimeVersion: conversion ? MINI_APP_CONVERSION_RUNTIME_VERSION : actions ? MINI_APP_ACTION_RUNTIME_VERSION : migration ? MINI_APP_MIGRATION_RUNTIME_VERSION : inputPresets ? MINI_APP_PRESET_RUNTIME_VERSION : viewports!.some(view => view.groups) ? MINI_APP_GROUP_RUNTIME_VERSION : viewports!.some(view => view.picking || view.cameraControls) ? MINI_APP_SCENE_RUNTIME_VERSION : document!.repeats?.length || document!.modernStyles ? MINI_APP_REPEAT_RUNTIME_VERSION : program!.hasConstants ? MINI_APP_CONSTANT_RUNTIME_VERSION : playback ? MINI_APP_RUNTIME_VERSION : MINI_APP_LEGACY_RUNTIME_VERSION };
}

export function validateMiniAppInputs(plan: Pick<MiniAppPlan1, "inputs">, value: unknown): JsonRecord {
  boundedJson(value, 64_000, "inputs");
  const v = jsonRecord(value, "inputs"), output: JsonRecord = {};
  exactKeys(v, plan.inputs.map(i => i.id), "inputs");
  for (const control of plan.inputs) {
    const item = v[control.id];
    if (control.type === "number" || control.type === "range") output[control.id] = number(item, `inputs/${control.id}`, control.min, control.max);
    else if (control.type === "text") output[control.id] = text(item, `inputs/${control.id}`, control.maxLength, true);
    else if (control.type === "select" && typeof item === "string" && control.options.some(o => o.value === item)) output[control.id] = item;
    else if (control.type === "checkbox" && typeof item === "boolean") output[control.id] = item;
    else miniAppError("STATE", `inputs/${control.id}`, "Input does not match its definition");
  }
  return output;
}

export function validateMiniAppCheckpoint(compiled: CompiledMiniApp, value: unknown): MiniAppCheckpoint {
  boundedJson(value, MINI_APP_LIMITS.replyBytes, "checkpoint");
  const v = jsonRecord(value, "checkpoint"); exactKeys(v, ["inputs", "state", "tick", "rng", "view"], "checkpoint");
  const view = validateMiniAppViewState(v.view, compiled.plan.viewports);
  if (!Number.isSafeInteger(v.tick) || (v.tick as number) < 0 || (v.tick as number) >= Number.MAX_SAFE_INTEGER
    || !Number.isInteger(v.rng) || (v.rng as number) < 0 || (v.rng as number) > 0xffffffff) miniAppError("STATE", "checkpoint", "Invalid logical clock or random state");
  return { inputs: validateMiniAppInputs(compiled.plan, v.inputs), state: validateMiniAppState(compiled.plan.stateSchema, v.state), tick: v.tick as number, rng: v.rng as number, ...(view ? { view } : {}) };
}

export function validateMiniAppResult(compiled: CompiledMiniApp, reply: MiniAppVmReply): MiniAppResult {
  const snapshot = validateMiniAppCheckpoint(compiled, reply.snapshot), frame = validateMiniAppFrame(reply.frame, compiled.document, compiled.plan.viewports);
  if (snapshot.view) snapshot.view = reconcileMiniAppView(snapshot.view, frame);
  if (compiled.plan.playback && compiled.plan.playback.mode !== "none" && !frame.playback) miniAppError("FRAME", "frame/playback", "Playable apps must report playback:{finished:boolean} derived from current state on every frame");
  return { snapshot, frame };
}
