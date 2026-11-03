import { answerDataDigest } from "../answer-output-receipts";
import { boundedJson, exactKeys, jsonRecord, type JsonValue } from "./json";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import type { MiniAppCheckpoint } from "./vm";

const LIMITS = Object.freeze({ items: 12, characters: 1200, valueCharacters: 256 });
type Change = { path: string } & ({ kind: "add"; after: JsonValue } | { kind: "remove"; before: JsonValue }
  | { kind: "replace"; before: JsonValue; after: JsonValue });
export interface MiniAppCheckpointChanges { complete: boolean; total: number; omitted: number; items: Change[] }
const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** Structural observations, never patches or semantic object identities. Arrays use positions. */
export function miniAppCheckpointChanges(before: MiniAppCheckpoint, after: MiniAppCheckpoint): MiniAppCheckpointChanges {
  boundedJson(before, MINI_APP_LIMITS.replyBytes); boundedJson(after, MINI_APP_LIMITS.replyBytes);
  const result: MiniAppCheckpointChanges = { complete: true, total: 0, omitted: 0, items: [] };
  const visit = (oldValue: unknown, newValue: unknown, path: string, had = true, has = true): void => {
    if (had && has && oldValue === newValue) return;
    if (had && has && object(oldValue) && object(newValue) && Array.isArray(oldValue) === Array.isArray(newValue)) {
      for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
        visit(oldValue[key], newValue[key], `${path}/${escape(key)}`, Object.hasOwn(oldValue, key), Object.hasOwn(newValue, key));
      }
      return;
    }
    result.total++;
    const item = { path, kind: !had ? "add" : !has ? "remove" : "replace",
      ...(had ? { before: oldValue } : {}), ...(has ? { after: newValue } : {}) };
    if (result.items.length < LIMITS.items && (!had || JSON.stringify(oldValue).length <= LIMITS.valueCharacters)
      && (!has || JSON.stringify(newValue).length <= LIMITS.valueCharacters)
      && JSON.stringify([...result.items, item]).length <= LIMITS.characters) result.items.push(JSON.parse(JSON.stringify(item)) as Change);
  };
  visit(before, after, "");
  result.omitted = result.total - result.items.length; result.complete = result.omitted === 0;
  return result;
}

function sourceValue(source: MiniAppCheckpoint, path: string): { present: boolean; value?: unknown } {
  let value: unknown = source;
  for (const part of path.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!object(value) || !Object.hasOwn(value, part)) return { present: false };
    value = value[part];
  }
  return { present: true, value };
}

/** Bounded structural evidence, without claiming to prove a prior checkpoint. */
export function validateMiniAppChangeSummary(value: unknown): MiniAppCheckpointChanges {
  boundedJson(value, 5000);
  const changes = jsonRecord(value, "preview/changes");
  exactKeys(changes, ["complete", "total", "omitted", "items"], "preview/changes");
  const fail = () => { throw new MiniAppError("PROTOCOL", "Invalid checkpoint change evidence"); };
  if (!Number.isSafeInteger(changes.total) || (changes.total as number) < 0 || (changes.total as number) > 2 * MINI_APP_LIMITS.jsonNodes
    || !Array.isArray(changes.items) || changes.items.length > LIMITS.items
    || changes.omitted !== (changes.total as number) - changes.items.length || (changes.omitted as number) < 0
    || changes.complete !== (changes.omitted === 0) || JSON.stringify(changes.items).length > LIMITS.characters) fail();
  const seen: string[] = [];
  for (const value of changes.items as unknown[]) {
    const item = jsonRecord(value, "preview/change");
    if (typeof item.path !== "string" || !/^\/(?:state|inputs|tick|rng|view)(?:\/.*)?$/.test(item.path)
      || /~(?![01])/.test(item.path) || !["add", "remove", "replace"].includes(String(item.kind))) fail();
    const path = item.path as string;
    if (seen.some(other => other === path || other.startsWith(path + "/") || path.startsWith(other + "/"))) fail();
    seen.push(path);
    exactKeys(item, ["path", "kind", ...(item.kind === "add" ? [] : ["before"]), ...(item.kind === "remove" ? [] : ["after"])], "preview/change");
    if (item.kind !== "add" && !Object.hasOwn(item, "before")) fail();
    if (item.kind !== "remove" && !Object.hasOwn(item, "after")) fail();
    if (item.kind === "replace" && answerDataDigest(item.before) === answerDataDigest(item.after)) fail();
    if (["before", "after"].some(key => Object.hasOwn(item, key) && JSON.stringify(item[key]).length > LIMITS.valueCharacters)) fail();
  }
  return value as MiniAppCheckpointChanges;
}

/** Full results are validated in the worker; recheck paths and before-values at the host boundary. */
export function validateMiniAppCheckpointChanges(source: MiniAppCheckpoint, value: unknown): MiniAppCheckpointChanges {
  const changes = validateMiniAppChangeSummary(value);
  for (const item of changes.items) {
    const current = sourceValue(source, item.path);
    if (item.kind === "add" ? current.present : !current.present || answerDataDigest(current.value) !== answerDataDigest(item.before)) {
      throw new MiniAppError("PROTOCOL", "Invalid checkpoint change evidence");
    }
  }
  return changes;
}
