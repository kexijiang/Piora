import { createHash } from "node:crypto";

export const EVALUATION_FORMAT_VERSION = 2;
export const sha256 = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const labels = new Set(["ui", "text", "clarify", "unsupported", "either"]);
const technicalKeys = ["calculation", "interaction", "saved", "reload", "followup"];
const outcomes = ["completed", "provider-error", "timeout", "cancelled", "admission-stopped"];
function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function validateEvaluationSuite(suite) {
  requireValue(suite && typeof suite.version === "string" && typeof suite.capabilityVersion === "string" && Array.isArray(suite.tasks), "Invalid evaluation suite");
  const ids = new Set(), families = new Map(), domains = new Map();
  for (const task of suite.tasks) {
    requireValue(typeof task.id === "string" && !ids.has(task.id), "Duplicate or missing task ID"); ids.add(task.id);
    requireValue(["development", "heldout"].includes(task.split) && labels.has(task.label), `Invalid split or label: ${task.id}`);
    requireValue(typeof task.family === "string" && task.family.length && typeof task.domain === "string" && task.domain.length, `Missing task family/domain: ${task.id}`);
    for (const [map, key] of [[families, task.family], [domains, task.domain]]) {
      requireValue(!map.has(key) || map.get(key) === task.split, `Task family/domain leaks across splits: ${key}`); map.set(key, task.split);
    }
    requireValue(Array.isArray(task.turns) && task.turns.length > 0 && task.turns.every(turn => typeof turn.user === "string" && turn.user.trim()), `Missing user conversation: ${task.id}`);
    requireValue(task.turns.every(turn => turn.label === undefined || labels.has(turn.label)), `Invalid turn label: ${task.id}`);
    if (task.label === "ui" || task.turns.some(turn => turn.label === "ui")) requireValue(Array.isArray(task.checks) && task.checks.length > 0, `UI task needs independent checks: ${task.id}`);
  }
  return suite;
}

/** Immutable run identity. Do not pass labels/checks to a model as task context. */
export function createEvaluationManifest(suite, { models, policyVersions, repetitions = 3, split = "development", baselineSha256, scope = "isolated-model-generation" }) {
  validateEvaluationSuite(suite);
  requireValue(["development", "heldout"].includes(split), "Select an explicit evaluation split");
  requireValue(Array.isArray(models) && models.length > 0 && new Set(models).size === models.length && models.every(m => typeof m === "string" && m.length), "Explicit unique model IDs required");
  requireValue(Array.isArray(policyVersions) && policyVersions.length > 0 && new Set(policyVersions).size === policyVersions.length && policyVersions.every(p => typeof p === "string" && p.length), "Explicit unique policy versions required");
  requireValue(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 20, "Invalid repetition count");
  requireValue(typeof baselineSha256 === "string" && /^[a-f0-9]{64}$/.test(baselineSha256), "Frozen baseline hash required");
  requireValue(["isolated-model-generation", "production-end-to-end"].includes(scope), "Invalid evaluation scope");
  const tasks = suite.tasks.filter(task => task.split === split);
  requireValue(tasks.length > 0, "Empty evaluation split");
  return {
    formatVersion: EVALUATION_FORMAT_VERSION, suiteVersion: suite.version, suiteSha256: sha256(suite),
    capabilityVersion: suite.capabilityVersion, baselineSha256, models, policyVersions, repetitions, split, scope,
    taskIds: tasks.map(task => task.id), taskCount: tasks.length,
    familyCount: new Set(tasks.map(task => task.family)).size,
    expectedRunCount: tasks.length * models.length * policyVersions.length * repetitions,
    humanReview: "Two independent reviewers; disagreements require adjudication. No model self-scoring.",
    statistics: "Repeated runs measure consistency. Task families are the independent units; do not treat repeats as additional tasks.",
  };
}

export function validateEvaluationRun(run, task, manifest) {
  requireValue(run?.taskId === task.id && manifest.taskIds.includes(task.id), "Task does not belong to frozen manifest");
  requireValue(manifest.models.includes(run.model) && manifest.policyVersions.includes(run.policyVersion), "Unplanned model or policy");
  requireValue(Number.isInteger(run.repetition) && run.repetition >= 1 && run.repetition <= manifest.repetitions, "Unplanned repetition");
  requireValue(outcomes.includes(run.outcome), "Invalid task outcome");
  requireValue(!run.transport?.scope || run.transport.scope === manifest.scope, "Run scope differs from the frozen manifest");
  requireValue(Array.isArray(run.turns) && run.turns.length <= task.turns.length, "Invalid conversation output");
  if (run.outcome === "completed") requireValue(run.turns.length === task.turns.length, "Completed output omits a user turn");
  for (let i = 0; i < run.turns.length; i++) {
    const turn = run.turns[i];
    requireValue(turn.user === task.turns[i].user && typeof turn.assistant === "string", "Output must retain the exact synthetic user turn and final answer");
    requireValue(Number.isFinite(turn.durationMs) && turn.durationMs >= 0 && Array.isArray(turn.uiAttempts), "Missing measured turn duration or attempts");
    const callIds = new Set();
    for (const attempt of turn.uiAttempts) {
      requireValue(typeof attempt.toolCallId === "string" && attempt.toolCallId.length && !callIds.has(attempt.toolCallId), "Duplicate or missing tool call ID"); callIds.add(attempt.toolCallId);
      requireValue(typeof attempt.toolName === "string" && typeof attempt.committed === "boolean", "Invalid UI attempt");
      requireValue(attempt.errorCode === undefined || typeof attempt.errorCode === "string", "Invalid diagnostic code");
    }
  }
  requireValue(Number.isFinite(run.durationMs) && run.durationMs >= 0, "Missing measured task duration");
  for (const record of [run.technical, run.firstAttemptTechnical].filter(Boolean)) {
    requireValue(technicalKeys.every(key => record[key] === undefined || typeof record[key] === "boolean"), "Technical checks must be boolean, not model scores");
  }
  const reviewers = new Set();
  for (const review of run.reviews ?? []) {
    requireValue(typeof review.reviewer === "string" && review.reviewer.trim() && !reviewers.has(review.reviewer), "Distinct reviewer identities required"); reviewers.add(review.reviewer);
    requireValue(typeof review.semanticCorrect === "boolean" && typeof review.choiceCorrect === "boolean", "Missing independent judgment");
    requireValue(review.clarificationUseful === undefined || typeof review.clarificationUseful === "boolean", "Invalid clarification judgment");
    requireValue(review.firstAttemptCorrect === undefined || typeof review.firstAttemptCorrect === "boolean", "Invalid first-attempt judgment");
  }
  return run;
}

function consensus(reviews, key) {
  if (reviews.length < 2 || reviews.some(review => typeof review[key] !== "boolean")) return null;
  return reviews.every(review => review[key] === reviews[0][key]) ? reviews[0][key] : null;
}
function checked(technical) {
  if (technicalKeys.some(key => technical?.[key] === false)) return false;
  return technicalKeys.every(key => technical?.[key] === true) ? true : null;
}
function observedTurns(task, run) {
  return task.turns.map((expected, index) => ({
    index, label: expected.label ?? (task.turns.length === 1 ? task.label : null),
    observed: !!run.turns[index], attempts: run.turns[index]?.uiAttempts ?? [],
  }));
}
function anyKnown(values) {
  if (values.includes(true)) return true;
  return values.includes(null) ? null : false;
}
function everyKnown(values) {
  if (values.includes(false)) return false;
  return values.length && values.every(value => value === true) ? true : null;
}
function selectionMiss(turn) { return turn.observed ? turn.attempts.length === 0 : null; }
function falseTrigger(turn) { return turn.observed ? turn.attempts.length > 0 : null; }
function taskSelectionMiss(turns) {
  return anyKnown(turns.flatMap(turn => turn.label === null ? [null] : turn.label === "ui" ? [selectionMiss(turn)] : []));
}
function taskFalseTrigger(turns) {
  return anyKnown(turns.flatMap(turn => turn.label === null ? [null] : turn.label === "text" ? [falseTrigger(turn)] : []));
}
function usability(run, turns, first = false, scope = "production-end-to-end") {
  if (scope === "isolated-model-generation") return null;
  // A task label describes the task, not the expected response in every turn.
  // Historical multi-turn suites without turn labels cannot prove routing correctness.
  if (turns.some(turn => turn.label === null)) return null;
  if (run.outcome !== "completed") return false;
  const uiTurns = turns.filter(turn => turn.label === "ui");
  if (!uiTurns.length) return null;
  if (turns.some(turn => ["text", "clarify", "unsupported"].includes(turn.label) && turn.attempts.length > 0)) return false;
  for (const turn of uiTurns) {
    const attempt = first ? turn.attempts[0] : turn.attempts.at(-1);
    if (!attempt?.committed || attempt.errorCode) return false;
  }
  const multiple = first && uiTurns.some(turn => turn.attempts.length > 1);
  const technical = checked(multiple ? run.firstAttemptTechnical : run.technical);
  const semantic = consensus(run.reviews ?? [], multiple ? "firstAttemptCorrect" : "semanticCorrect");
  const choice = consensus(run.reviews ?? [], "choiceCorrect");
  if (technical === false || semantic === false || choice === false) return false;
  return technical === true && semantic === true && choice === true ? true : null;
}
function metric(values) {
  const numerator = values.filter(value => value === true).length, pending = values.filter(value => value === null).length;
  return { numerator, denominator: values.length, pending, value: values.length && !pending ? numerator / values.length : null };
}

export function summarizeEvaluation(suite, manifest, runs) {
  validateEvaluationSuite(suite);
  requireValue(manifest.suiteSha256 === sha256(suite), "Suite differs from frozen run manifest");
  const tasks = new Map(suite.tasks.map(task => [task.id, task])), seen = new Set();
  for (const run of runs) {
    const task = tasks.get(run.taskId); requireValue(task, "Unknown task"); validateEvaluationRun(run, task, manifest);
    const key = JSON.stringify([run.taskId, run.model, run.policyVersion, run.repetition]);
    requireValue(!seen.has(key), "Duplicate task run would inflate sample count"); seen.add(key);
  }
  const groups = [];
  for (const model of manifest.models) for (const policyVersion of manifest.policyVersions) {
    const group = runs.filter(run => run.model === model && run.policyVersion === policyVersion);
    const rows = group.map(run => {
      const task = tasks.get(run.taskId);
      return { run, task, turns: observedTurns(task, run) };
    });
    // Explicit user cancellation is separately reported; provider errors/model stops stay in E2E denominators.
    const cancelled = rows.filter(({ run }) => run.outcome === "cancelled" && run.cancellationSource === "user");
    const eligible = rows.filter(row => !cancelled.includes(row));
    const ui = eligible.filter(({ task, turns }) => task.label === "ui" || turns.some(turn => turn.label === "ui"));
    const selected = ui.filter(({ turns }) => turns.some(turn => turn.label === "ui" && turn.attempts.length > 0));
    const text = eligible.filter(({ task, turns }) => task.label === "text" || turns.some(turn => turn.label === "text"));
    const clarify = eligible.filter(({ task }) => task.label === "clarify");
    const turns = eligible.flatMap(row => row.turns);
    const uiTurns = turns.filter(turn => turn.label === "ui"), textTurns = turns.filter(turn => turn.label === "text");
    const perLabel = Object.fromEntries([...labels].map(label => [label, rows.filter(row => row.task.label === label).length]));
    groups.push({
      model, policyVersion, split: manifest.split, scope: manifest.scope, runCount: group.length,
      expectedRunCount: manifest.taskCount * manifest.repetitions, complete: group.length === manifest.taskCount * manifest.repetitions,
      taskCount: new Set(rows.map(row => row.task.id)).size, familyCount: new Set(rows.map(row => row.task.family)).size, perLabel,
      exclusions: { userCancelled: cancelled.length, unsupported: rows.filter(row => row.task.label === "unsupported").length, either: rows.filter(row => row.task.label === "either").length },
      outcomes: Object.fromEntries(outcomes.map(outcome => [outcome, group.filter(run => run.outcome === outcome).length])),
      selectionMiss: metric(ui.map(({ turns }) => taskSelectionMiss(turns))),
      falseTrigger: metric(text.map(({ turns }) => taskFalseTrigger(turns))),
      turnSelection: {
        knownLabelsOnly: true, labelCoverageComplete: turns.every(turn => turn.label !== null),
        unlabeledTurns: turns.filter(turn => turn.label === null).length,
        unobservedTurns: turns.filter(turn => !turn.observed).length,
        selectionMiss: metric(uiTurns.map(selectionMiss)), falseTrigger: metric(textTurns.map(falseTrigger)),
      },
      firstUsable: metric(ui.map(({ run, turns }) => usability(run, turns, true, manifest.scope))),
      finalUsable: metric(ui.map(({ run, turns }) => usability(run, turns, false, manifest.scope))),
      selectedGenerationFailure: metric(selected.map(({ run, turns }) => { const result = usability(run, turns, false, manifest.scope); return result === null ? null : !result; })),
      // This measures only structural generation, never business correctness or persistence.
      structurallyValidGeneration: metric(ui.map(({ turns }) => {
        if (turns.some(turn => turn.label === null)) return null;
        return everyKnown(turns.filter(turn => turn.label === "ui").map(({ attempts }) => {
          if (!attempts.length) return false;
          const values = attempts.map(attempt => attempt.evidence?.generationValid);
          return values.includes(true) ? true : values.every(value => value === false) ? false : null;
        }));
      })),
      clarificationQuality: metric(clarify.map(({ run }) => run.outcome === "completed" ? consensus(run.reviews ?? [], "clarificationUseful") : false)),
      unsupportedHandling: metric(eligible.filter(({ task }) => task.label === "unsupported").map(({ run }) => run.outcome === "completed" ? consensus(run.reviews ?? [], "choiceCorrect") : false)),
      // Preserve failures and raw family membership for cluster statistics; never pool repetitions as independent samples.
      tasks: rows.map(({ run, task, turns }) => ({
        taskId: task.id, family: task.family, domain: task.domain, label: task.label, repetition: run.repetition,
        outcome: run.outcome, durationMs: run.durationMs, attemptCount: turns.reduce((n, turn) => n + turn.attempts.length, 0),
        errorCodes: turns.flatMap(turn => turn.attempts.flatMap(a => a.errorCode ? [a.errorCode] : [])),
        turns: turns.map(turn => ({ turnIndex: turn.index, expectedLabel: turn.label, observed: turn.observed,
          attemptCount: turn.attempts.length,
          selectionMiss: turn.label === "ui" ? selectionMiss(turn) : null,
          falseTrigger: turn.label === "text" ? falseTrigger(turn) : null,
        })),
      })),
      intervals: null, intervalNote: "No stability claim: inspect family counts and preregister category minimums before estimating clustered intervals.",
    });
  }
  return { formatVersion: EVALUATION_FORMAT_VERSION, suiteSha256: manifest.suiteSha256, complete: runs.length === manifest.expectedRunCount, groups };
}
