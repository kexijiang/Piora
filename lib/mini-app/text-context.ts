import type { MiniAppDocument } from "./document";
import type { MiniAppFrame } from "./frame";

/** Exact current projection values, not a claim about visibility or domain correctness. */
export function miniAppTextContext(document: MiniAppDocument, frame: MiniAppFrame, characters = 2000) {
  const ids = [...new Set(document.bindings.filter(binding => !binding.attribute).map(binding => binding.id))];
  const result = { scope: "current-projection-text-bindings", values: [] as Array<{ id: string; text: string }>, omitted: ids.length };
  for (const id of ids) {
    if (!Object.hasOwn(frame.bindings, id)) continue;
    const text = String(frame.bindings[id]);
    if (text.length > 1000 || result.values.length >= 32) continue;
    result.values.push({ id, text }); result.omitted--;
    if (JSON.stringify(result).length > characters) { result.values.pop(); result.omitted++; }
  }
  return result;
}
