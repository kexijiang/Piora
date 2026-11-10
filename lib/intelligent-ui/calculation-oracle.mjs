import { createJiti } from 'jiti';
const { validateSurface, initialState, validateState, evaluateExpression } = await createJiti(import.meta.url).import('./surface-document.ts');
const close = (a, b) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b));

export function checkCalculationAttempts(attempts, oracle) {
  const check = attempt => !attempt ? { status: 'no-ui' } : !attempt.evidence?.generationValid ? { status: 'invalid-generation' }
    : checkCalculationTrajectory(attempt.evidence.surface, oracle);
  return { first: check(attempts[0]), final: check(attempts.findLast(a => a.evidence?.generationValid) ?? attempts.at(-1)) };
}

/** Offline, value-only checks. Ambiguous input associations stay unassessed.
 * A match proves a numeric trajectory, never what the label means or that it saved. */
export function checkCalculationTrajectory(raw, oracle) {
  if (!oracle || !Array.isArray(oracle.steps) || oracle.steps.length < 2 || !Array.isArray(oracle.expected)
    || !oracle.expected.length || !oracle.expected.every(values => Array.isArray(values) && values.length === oracle.steps.length && values.every(Number.isFinite))) {
    throw new Error('Oracle requires at least two steps and complete finite expected trajectories');
  }
  let surface;
  try { surface = validateSurface(raw); } catch { return { status: 'invalid-surface' }; }
  const state = initialState(surface), bindings = {}, used = new Set();
  for (const [key, selector] of Object.entries(oracle.controls)) {
    const candidates = surface.nodes.filter(n => (selector.type === 'number' ? ['number', 'slider'].includes(n.type) : n.type === selector.type)
      && (selector.initial === undefined || [selector.initial].flat().some(value => close(n.value, value))));
    if (candidates.length !== 1 || used.has(candidates[0].id)) return { status: 'unmapped', control: key, matches: candidates.length };
    bindings[key] = candidates[0]; used.add(candidates[0].id);
  }
  const roots = surface.nodes.flatMap(n => n.type === 'metric' ? [{ path: `${n.id}.value`, expression: n.value }]
    : n.type === 'table' ? n.rows.flatMap((r, i) => r.map((expression, j) => ({ path: `${n.id}.rows[${i}][${j}]`, expression })))
      : n.type === 'barChart' ? n.values.map((expression, i) => ({ path: `${n.id}.values[${i}]`, expression }))
        : n.type === 'dynamicText' ? n.parts.map((expression, i) => ({ path: `${n.id}.parts[${i}]`, expression })) : []);
  const trajectories = roots.map(root => ({ path: root.path, values: [] }));
  for (const [index, step] of oracle.steps.entries()) {
    for (const [key, assignment] of Object.entries(step)) {
      const node = bindings[key];
      if (!node) throw new Error('Oracle assignment has no selector');
      let value = assignment;
      if (assignment && typeof assignment === 'object') {
        if (assignment.option !== undefined) {
          const matches = node.options?.filter(option => new RegExp(assignment.option, 'u').test(option));
          if (matches?.length !== 1) return { status: 'unmapped', control: key, optionMatches: matches?.length ?? 0 };
          value = matches[0];
        } else value = assignment.byInitial?.[String(node.value)];
      }
      state[node.id] = value;
    }
    try { validateState(surface, state); } catch { return { status: 'input-rejected', step: index }; }
    roots.forEach((root, i) => {
      try { trajectories[i].values.push(evaluateExpression(root.expression, state)); }
      catch { trajectories[i].values.push(null); }
    });
  }
  const matches = oracle.expected.map(expected => trajectories.filter(t => t.values.length === expected.length
    && expected.every((value, i) => close(t.values[i], value))).map(t => t.path));
  return { status: matches.every(paths => paths.length) ? 'matched' : 'mismatch', matches, trajectories };
}
