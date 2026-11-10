import type { MiniAppDocument, MiniAppDocumentNode } from "./document";
import { exactKeys, jsonRecord, readId } from "./json";
import { MINI_APP_LIMITS, miniAppError, MiniAppError } from "./limits";

export type MiniAppScalar = string | number | boolean;
export interface MiniAppRepeatField {
  id: string; type: "text" | "number" | "range" | "checkbox" | "select";
  min?: number; max?: number; step?: number; maxLength?: number; options?: string[];
}
export interface MiniAppRepeat {
  id: string; template: MiniAppDocumentNode[];
  bindings: Array<{ id: string; attribute?: string }>; events: string[]; fields: MiniAppRepeatField[];
}
export interface MiniAppRepeatRow { key: string; bindings: Record<string, MiniAppScalar> }
export type MiniAppRepeatData = Record<string, MiniAppRepeatRow[]>;

/** Whole values and original positions only; omitted rows are never defaults. */
export function miniAppRepeatContext(data: MiniAppRepeatData | undefined, budget = 3000) {
  if (!data || !Object.keys(data).length) return undefined;
  const lists = Object.entries(data).map(([id, rows]) => ({ id, totalRows: rows.length,
    rows: [] as Array<MiniAppRepeatRow & { index: number }>, omittedRows: rows.length }));
  for (const list of lists) for (const [index, row] of data[list.id].entries()) {
    list.rows.push({ index, key: row.key, bindings: row.bindings }); list.omittedRows--;
    if (JSON.stringify(lists).length > budget) { list.rows.pop(); list.omittedRows++; }
  }
  return lists;
}

export function compileMiniAppRepeatField(node: Extract<MiniAppDocumentNode, { type: "element" }>): MiniAppRepeatField {
  const attrs = node.attrs, id = readId(attrs["data-field"], "document/data-field"), path = `document/fields/${id}`;
  if (!attrs["aria-label"]?.trim() || ["value", "checked", "selected", "disabled", "data-event", "data-input", "data-text"].some(key => key in attrs)) {
    miniAppError("BINDING", path, "Row fields require an accessible label; their values come from row bindings");
  }
  const type = node.tag === "select" ? "select" : attrs.type ?? "text";
  if (!["input", "select"].includes(node.tag) || !["text", "number", "range", "checkbox", "select"].includes(type)) miniAppError("BINDING", path, "Unsupported row control");
  if (type === "select") {
    const options = node.children.filter(child => child.type !== "text" || child.text.trim());
    if (!options.length || options.length > 32 || options.some(child => child.type !== "element" || child.tag !== "option" || !child.attrs.value || child.attrs.value.length > 120 || child.children.some(n => n.type !== "text"))) miniAppError("BINDING", path, "Select requires bounded literal options");
    const values = options.map(child => (child as Extract<MiniAppDocumentNode, { type: "element" }>).attrs.value);
    if (new Set(values).size !== values.length) miniAppError("BINDING", path, "Select values must be unique");
    return { id, type, options: values };
  }
  attrs.type = type;
  if (type === "checkbox") return { id, type };
  if (type === "text") {
    const maxLength = Number(attrs.maxlength ?? 2000);
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 2000) miniAppError("BINDING", path, "Row text limit must be between 1 and 2000");
    attrs.maxlength = String(maxLength);
    return { id, type, maxLength };
  }
  const min = Number(attrs.min), max = Number(attrs.max), step = Number(attrs.step ?? 1);
  if (![min, max, step].every(Number.isFinite) || min < -1e12 || max > 1e12 || min > max || step <= 0 || step > 1e12) miniAppError("BINDING", path, "Numeric row controls require finite min/max and a positive step");
  return { id, type: type as "number" | "range", min, max, step };
}

export function validateMiniAppRepeatField(field: MiniAppRepeatField, value: unknown, path: string): MiniAppScalar {
  if (field.type === "checkbox" && typeof value === "boolean") return value;
  if (field.type === "text" && typeof value === "string" && value.length <= field.maxLength!) return value;
  if (field.type === "select" && typeof value === "string" && field.options!.includes(value)) return value;
  if ((field.type === "number" || field.type === "range") && typeof value === "number" && Number.isFinite(value) && value >= field.min! && value <= field.max!) return value;
  return miniAppError("BINDING", path, "Row value does not match its declared field");
}

export function validateMiniAppRepeats(value: unknown, document: MiniAppDocument,
  validateAttribute: (attribute: string, value: string) => void): MiniAppRepeatData {
  const source = value === undefined ? {} : jsonRecord(value, "frame/repeats");
  const definitions = document.repeats ?? [];
  exactKeys(source, definitions.map(item => item.id), "frame/repeats");
  const output: MiniAppRepeatData = {};
  let nodes = 0, text = 0, events = 0;
  const count = (node: MiniAppDocumentNode) => {
    nodes++;
    if (node.type === "text") text += node.text.length;
    else { text += Object.values(node.attrs).join("").length; events += Number(Boolean(node.attrs["data-event"] || node.attrs["data-field"] || node.attrs["data-input"])); node.children.forEach(count); }
  };
  document.nodes.forEach(count);
  for (const definition of definitions) {
    const path = `frame/repeats/${definition.id}`, rows = source[definition.id];
    if (!Array.isArray(rows) || rows.length > MINI_APP_LIMITS.repeatRows) miniAppError("FRAME", path, "Every repeat needs an array within the row limit");
    const keys = new Set<string>();
    output[definition.id] = rows.map((value, index) => {
      const rowPath = `${path}/${index}`, row = jsonRecord(value, rowPath); exactKeys(row, ["key", "bindings"], rowPath);
      const key = readId(row.key, `${rowPath}/key`);
      if (keys.has(key)) miniAppError("FRAME", `${rowPath}/key`, "Row keys must be unique and stable across reorderings");
      keys.add(key);
      const bindings: Record<string, MiniAppScalar> = {};
      for (const [id, item] of Object.entries(jsonRecord(row.bindings, `${rowPath}/bindings`))) {
        readId(id, rowPath);
        if (!["string", "number", "boolean"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item) || typeof item === "string" && item.length > 16_000) miniAppError("FRAME", rowPath, "Row bindings must be finite scalars");
        bindings[id] = item as MiniAppScalar;
      }
      for (const binding of definition.bindings) {
        if (!Object.hasOwn(bindings, binding.id)) miniAppError("BINDING", `${rowPath}/${binding.id}`, "Missing row binding");
        if (binding.attribute) validateAttribute(binding.attribute, String(bindings[binding.id]));
        text += String(bindings[binding.id]).length;
      }
      for (const field of definition.fields) { validateMiniAppRepeatField(field, bindings[field.id], `${rowPath}/${field.id}`); text += String(bindings[field.id]).length; }
      definition.template.forEach(count);
      if (nodes > MINI_APP_LIMITS.documentNodes || text > MINI_APP_LIMITS.repeatText || events > MINI_APP_LIMITS.repeatEvents) miniAppError("LIMIT", path, "Expanded rows exceed the document, text or interaction budget");
      return { key, bindings };
    });
  }
  return output;
}

/** Each controller owns this identity history. A removed/recreated key receives a
 * new generation; queued typing on a still-live row retains its intended target. */
export class MiniAppRepeatIdentity {
  private revision = 0;
  private generation = 0;
  private current = new Map<string, number>();
  private readonly frames = new Map<number, Map<string, number>>();
  reset(): void { this.current.clear(); this.frames.clear(); }
  publish(data: MiniAppRepeatData = {}): number {
    const next = new Map<string, number>();
    for (const [id, rows] of Object.entries(data)) for (const row of rows) {
      const key = `${id}/${row.key}`;
      next.set(key, this.current.get(key) ?? ++this.generation);
    }
    this.current = next;
    this.frames.set(++this.revision, next);
    if (this.frames.size > MINI_APP_LIMITS.repeatFrameHistory) this.frames.delete(this.frames.keys().next().value!);
    return this.revision;
  }
  validate(event: { repeat?: unknown; key?: unknown; frame?: unknown }): void {
    if (typeof event.repeat !== "string" || typeof event.key !== "string" || !Number.isSafeInteger(event.frame)) throw new MiniAppError("STALE_EVENT", "Row event has no valid frame identity");
    const key = `${event.repeat}/${event.key}`, generation = this.current.get(key);
    if (generation === undefined || this.frames.get(event.frame as number)?.get(key) !== generation) throw new MiniAppError("STALE_EVENT", "Row was removed, replaced or its displayed frame expired");
  }
}
