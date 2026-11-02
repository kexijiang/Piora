import { MINI_APP_LIMITS, miniAppError } from "./limits";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };
export const MINI_APP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const forbidden = new Set(["__proto__", "constructor", "prototype", "toJSON"]);
const encoder = new TextEncoder();

/** Bounds traversal before serialization; never invokes getters or toJSON. */
export function boundedJson(value: unknown, maxBytes: number, path = ""): string {
  let nodes = 0, lowerBound = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number, at: string): void => {
    if (++nodes > MINI_APP_LIMITS.jsonNodes || depth > MINI_APP_LIMITS.depth) miniAppError("LIMIT", at, "JSON structure exceeds the runtime budget");
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { lowerBound += 4; }
    else if (typeof item === "string") {
      if (item.length > maxBytes) miniAppError("LIMIT", at, "Text exceeds the runtime budget");
      lowerBound += item.length;
    } else if (item && typeof item === "object") {
      if (seen.has(item)) miniAppError("SCHEMA", at, "JSON cannot contain a cycle");
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) miniAppError("SCHEMA", at, "Expected a plain JSON value");
      if (Array.isArray(item) && item.length > MINI_APP_LIMITS.jsonNodes) miniAppError("LIMIT", at, "Array exceeds the runtime budget");
      seen.add(item);
      const keys = Reflect.ownKeys(item);
      if (keys.length > MINI_APP_LIMITS.jsonNodes) miniAppError("LIMIT", at, "Object exceeds the runtime budget");
      for (const key of keys) {
        if (Array.isArray(item) && key === "length") continue;
        if (typeof key !== "string" || forbidden.has(key)) miniAppError("SCHEMA", at, "Unsupported JSON property");
        if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key)) miniAppError("SCHEMA", at, "Arrays may only contain indexed values");
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) miniAppError("SCHEMA", at, "Accessors and hidden properties are not JSON data");
        lowerBound += key.length + 3;
        visit(descriptor.value, depth + 1, `${at}/${key}`);
      }
      if (Array.isArray(item) && keys.length !== item.length + 1) miniAppError("SCHEMA", at, "Sparse arrays are not supported");
      seen.delete(item);
    } else miniAppError("SCHEMA", at, "Expected a finite JSON value");
    if (lowerBound > maxBytes) miniAppError("LIMIT", at, "JSON exceeds the runtime budget");
  };
  visit(value, 0, path);
  const encoded = JSON.stringify(value);
  if (encoder.encode(encoded).byteLength > maxBytes) miniAppError("LIMIT", path, "JSON exceeds the runtime budget");
  return encoded;
}

export function jsonRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) miniAppError("SCHEMA", path, "Expected an object");
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) miniAppError("SCHEMA", `${path}/${key}`,
    `Unsupported field. Remove it instead of using an extra placeholder. Allowed keys for this object${allowed.join(", ").length > 450 ? " (truncated)" : ""}: ${allowed.join(", ").slice(0, 450)}.`);
}

export function readId(value: unknown, path: string): string {
  if (typeof value !== "string" || !MINI_APP_ID.test(value) || forbidden.has(value)) miniAppError("SCHEMA", path, "Expected a stable identifier");
  return value;
}
