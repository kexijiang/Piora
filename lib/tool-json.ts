import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

/** Check the SDK's JSON-only tool-call boundary without coercing caller data. */
export function assertToolJsonObject(value: unknown): asserts value is JsonObject {
  const ancestors = new Set<object>();
  const valid = (item: unknown): item is JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    const result = Array.isArray(item) ? item.every(valid) : Object.values(item).every(valid);
    ancestors.delete(item);
    return result;
  };
  if (!value || Array.isArray(value) || typeof value !== "object" || !valid(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
}
