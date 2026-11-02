import { boundedJson, exactKeys, jsonRecord, readId, type JsonValue } from "./json";
import { MINI_APP_LIMITS, miniAppError } from "./limits";

/** Deliberately bounded JSON Schema subset. No references, patterns or coercion. */
export type MiniAppStateSchema =
  | { type: "null" | "boolean" }
  | { type: "number" | "integer"; minimum: number; maximum: number }
  | { type: "string"; maxLength: number; enum?: string[] }
  | { type: "array"; maxItems: number; items: MiniAppStateSchema }
  | { type: "object"; properties: Record<string, MiniAppStateSchema>; required: string[]; additionalProperties: false };

export function compileMiniAppStateSchema(input: unknown): MiniAppStateSchema {
  boundedJson(input, 24_000, "stateSchema");
  let count = 0;
  const walk = (value: unknown, path: string, depth: number): MiniAppStateSchema => {
    if (++count > 128 || depth > 8) miniAppError("LIMIT", path, "State schema is too complex");
    const v = jsonRecord(value, path);
    if (v.type === "boolean" || v.type === "null") {
      exactKeys(v, ["type"], path); return { type: v.type };
    }
    if (v.type === "number" || v.type === "integer") {
      exactKeys(v, ["type", "minimum", "maximum"], path);
      if (typeof v.minimum !== "number" || typeof v.maximum !== "number" || !Number.isFinite(v.minimum) || !Number.isFinite(v.maximum)
        || v.minimum < -1e12 || v.maximum > 1e12 || v.minimum > v.maximum
        || v.type === "integer" && (!Number.isSafeInteger(v.minimum) || !Number.isSafeInteger(v.maximum))) miniAppError("SCHEMA", path, "State numbers require finite minimum and maximum between -1e12 and 1e12");
      return { type: v.type, minimum: v.minimum, maximum: v.maximum };
    }
    if (v.type === "string") {
      exactKeys(v, ["type", "maxLength", "enum"], path);
      if (!Number.isSafeInteger(v.maxLength) || (v.maxLength as number) < 0 || (v.maxLength as number) > 4000) miniAppError("SCHEMA", path, "State strings require maxLength between 0 and 4000");
      if (v.enum !== undefined && (!Array.isArray(v.enum) || v.enum.length < 1 || v.enum.length > 64
        || v.enum.some(s => typeof s !== "string" || s.length > (v.maxLength as number)) || new Set(v.enum).size !== v.enum.length)) miniAppError("SCHEMA", path, "Invalid string enumeration");
      return { type: "string", maxLength: v.maxLength as number, ...(v.enum ? { enum: v.enum as string[] } : {}) };
    }
    if (v.type === "array") {
      exactKeys(v, ["type", "maxItems", "items"], path);
      if (!Number.isSafeInteger(v.maxItems) || (v.maxItems as number) < 0 || (v.maxItems as number) > 2000) miniAppError("SCHEMA", path, "State arrays require maxItems between 0 and 2000");
      return { type: "array", maxItems: v.maxItems as number, items: walk(v.items, `${path}/items`, depth + 1) };
    }
    if (v.type !== "object") miniAppError("SCHEMA", path, "Unsupported state schema type");
    exactKeys(v, ["type", "properties", "required", "additionalProperties"], path);
    const source = jsonRecord(v.properties, `${path}/properties`), keys = Object.keys(source);
    if (keys.length > 64 || v.additionalProperties !== false || !Array.isArray(v.required)
      || new Set(v.required).size !== v.required.length || v.required.length !== keys.length || keys.some(key => !(v.required as unknown[]).includes(key))) miniAppError("SCHEMA", path, "State objects must explicitly require every property and disallow extra properties");
    const properties: Record<string, MiniAppStateSchema> = {};
    for (const key of keys) properties[readId(key, path)] = walk(source[key], `${path}/properties/${key}`, depth + 1);
    return { type: "object", properties, required: [...keys], additionalProperties: false };
  };
  return walk(input, "stateSchema", 0);
}

export function validateMiniAppState(schema: MiniAppStateSchema, value: unknown): JsonValue {
  boundedJson(value, MINI_APP_LIMITS.stateBytes, "state");
  const walk = (s: MiniAppStateSchema, v: unknown, path: string): void => {
    if (s.type === "null" && v === null || s.type === "boolean" && typeof v === "boolean") return;
    if ((s.type === "number" || s.type === "integer") && typeof v === "number" && Number.isFinite(v) && v >= s.minimum && v <= s.maximum && (s.type !== "integer" || Number.isSafeInteger(v))) return;
    if (s.type === "string" && typeof v === "string" && v.length <= s.maxLength && (!s.enum || s.enum.includes(v))) return;
    if (s.type === "array" && Array.isArray(v) && v.length <= s.maxItems) { v.forEach((item, i) => walk(s.items, item, `${path}/${i}`)); return; }
    if (s.type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      if (Object.keys(record).length === s.required.length && s.required.every(key => Object.hasOwn(record, key))) {
        for (const key of s.required) walk(s.properties[key], record[key], `${path}/${key}`);
        return;
      }
    }
    miniAppError("STATE", path, "State does not match its declared schema");
  };
  walk(schema, value, "state");
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
