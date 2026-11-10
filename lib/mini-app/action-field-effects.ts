import { answerDataDigest } from "../answer-output-receipts";
import type { MiniAppActionContextEvidence } from "./action-preview";
import type { JsonValue } from "./json";
import type { MiniAppCheckpoint } from "./vm";

const LIMITS = Object.freeze({ fields: 12, characters: 1600, valueCharacters: 128 });
type Value = { present: false } | { present: true; value: JsonValue };
export interface MiniAppActionFieldEffects {
  scope: "current-state-and-input-leaves";
  omittedFields: number;
  fields: Array<{ path: string; current: JsonValue; unchanged: string[];
    outcomes: Array<Value & { actions: string[] }>; unknown: string[] }>;
}
const object = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === "object";
const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const parts = (path: string) => path.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** A transposed view of verified differences, not a goal evaluator or interaction history.
 * Unknown and disabled actions never become evidence that a value is preserved.
 * Only current leaves are indexed; newly introduced fields remain in changes. */
export function miniAppActionFieldEffects(source: MiniAppCheckpoint, evidence: MiniAppActionContextEvidence): MiniAppActionFieldEffects {
  const result: MiniAppActionFieldEffects = { scope: "current-state-and-input-leaves", omittedFields: 0, fields: [] };
  const visit = (current: JsonValue, path: string): void => {
    if (object(current) && Object.keys(current).length) {
      for (const key of Object.keys(current)) visit(current[key], `${path}/${escape(key)}`);
      return;
    }
    if (result.fields.length >= LIMITS.fields || JSON.stringify(current).length > LIMITS.valueCharacters) {
      result.omittedFields++; return;
    }
    const row: MiniAppActionFieldEffects["fields"][number] = { path, current, unchanged: [], outcomes: [], unknown: [] };
    for (const action of evidence.actions) {
      if (action.status !== "ok") continue;
      const change = action.changes.items.find(item => path === item.path || path.startsWith(item.path + "/"));
      let after: Value;
      if (change) {
        if (change.kind === "remove") after = { present: false };
        else {
          let value: JsonValue = change.after, present = true;
          for (const key of parts(path).slice(parts(change.path).length)) {
            if (!object(value) || !Object.hasOwn(value, key)) { present = false; break; }
            value = value[key];
          }
          after = present ? { present: true, value } : { present: false };
        }
      } else if (action.changes.complete && !action.changes.items.some(item => overlaps(path, item.path))) {
        after = { present: true, value: current };
      } else { row.unknown.push(action.id); continue; }
      if (after.present && JSON.stringify(after.value).length > LIMITS.valueCharacters) { row.unknown.push(action.id); continue; }
      if (after.present && answerDataDigest(after.value) === answerDataDigest(current)) row.unchanged.push(action.id);
      else {
        const group = row.outcomes.find(item => item.present === after.present
          && (!item.present || after.present && answerDataDigest(item.value) === answerDataDigest(after.value)));
        if (group) group.actions.push(action.id);
        else row.outcomes.push({ ...after, actions: [action.id] });
      }
    }
    result.fields.push(row);
    if (JSON.stringify(result.fields).length > LIMITS.characters) { result.fields.pop(); result.omittedFields++; }
  };
  visit(source.state, "/state"); visit(source.inputs, "/inputs");
  return result;
}
