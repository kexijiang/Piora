import { evaluateExpression, initialState, validateState, type UiExpression, type UiNode, type UiState, type UiSurface, type UiValue } from "./protocol";
import type { UiRichNode, UiRichSurface } from "./rich-protocol";
import { UiPlanError } from "./plan-types";

/** Generation-only checks. Persisted historical surfaces keep their original semantics. */
export const UI_INPUT_TRIAL_POLICY = Object.freeze({ version: "input-boundaries-1", maxSamples: 128 });
type Control = Extract<UiNode, { type: "number" | "slider" | "select" | "checkbox" }>;
type Surface = UiSurface | UiRichSurface;
const isControl = (node: UiRichNode): node is Control => ["number", "slider", "select", "checkbox"].includes(node.type);
const controlsOf = (surface: Surface): Control[] => (surface.nodes as readonly UiRichNode[]).filter(isControl);

export function uiInputTrialSamples(surface: Surface): { states: UiState[]; truncated: boolean } {
  const basic = surface as UiSurface; // State helpers only inspect the shared input node types.
  const initial = initialState(basic), controls = controlsOf(surface);
  const candidates = controls.map(control => {
    let values: UiValue[];
    if (control.type === "checkbox") values = [!control.value];
    else if (control.type === "select") values = control.options;
    else {
      const step = control.step ?? 1;
      values = [0, control.min, control.max, control.value - step, control.value + step,
        control.min === undefined ? undefined : control.min + step,
        control.max === undefined ? undefined : control.max - step]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    }
    return [...new Set(values)].filter(value => {
      if (value === control.value) return false;
      try { validateState(basic, { ...initial, [control.id]: value }); return true; }
      catch { return false; }
    });
  });
  const states = [initial], seen = new Set([JSON.stringify(initial)]);
  let truncated = false;
  const add = (state: UiState): boolean => {
    const key = JSON.stringify(state);
    if (seen.has(key)) return true;
    if (states.length >= UI_INPUT_TRIAL_POLICY.maxSamples) { truncated = true; return false; }
    seen.add(key); states.push(state); return true;
  };
  // Round-robin prevents a long option list from consuming every other input's checks.
  const count = Math.max(0, ...candidates.map(values => values.length));
  for (let v = 0; v < count; v++) for (let c = 0; c < controls.length; c++) {
    if (v < candidates[c].length && !add({ ...initial, [controls[c].id]: candidates[c][v] })) return { states, truncated };
  }
  for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
    for (const av of candidates[a]) for (const bv of candidates[b]) {
      if (!add({ ...initial, [controls[a].id]: av, [controls[b].id]: bv })) return { states, truncated };
    }
  }
  return { states, truncated };
}

export function trialUiInputBoundaries(surface: Surface): { version: string; sampleCount: number; truncated: boolean } {
  const { states, truncated } = uiInputTrialSamples(surface);
  const roots: Array<{ value: UiExpression; path: string }> = [];
  surface.nodes.filter(node => !isControl(node)).forEach((node, index) => {
    const path = `$.views[${index}]`;
    if (node.type === "metric") roots.push({ value: node.value, path: `${path}.value` });
    if (node.type === "dynamicText") node.parts.forEach((value, i) => roots.push({ value, path: `${path}.parts[${i}]` }));
    if (node.type === "table") node.rows.forEach((row, r) => row.forEach((value, c) => roots.push({ value, path: `${path}.rows[${r}][${c}]` })));
    if (node.type === "barChart") node.values.forEach((value, i) => roots.push({ value, path: `${path}.values[${i}]` }));
  });
  for (let i = 0; i < states.length; i++) for (const root of roots) {
    try { evaluateExpression(root.value, states[i]); }
    catch {
      // Report structural input indexes, never echo model-provided labels or values.
      const controls = controlsOf(surface);
      const changed = controls.map((node, index) => states[i][node.id] !== states[0][node.id] ? `inputs[${index}]` : "").filter(Boolean);
      throw new UiPlanError("PLAN_INPUT_EVALUATION", root.path,
        `Displayed results must evaluate at valid input boundaries (${changed.join(", ") || "defaults"}); check zero divisors and numeric range. Preserve the intended domain; do not silently narrow inputs to hide the error.`);
    }
  }
  return { version: UI_INPUT_TRIAL_POLICY.version, sampleCount: states.length, truncated };
}
