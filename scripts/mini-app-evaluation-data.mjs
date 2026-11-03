import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function validateFirstTaskSuite(suite) {
  if (suite?.version !== 'phase3-first-tasks-1' || suite.split !== 'development' || suite.tasks?.length !== 8) throw new Error('Expected the eight development tasks');
  const ids = new Set(), families = new Set(), forms = new Set(['non-ui', 'intelligent-ui', 'mini-app']);
  for (const task of suite.tasks) {
    if (!/^[a-z][a-z0-9-]+$/.test(task.id) || ids.has(task.id) || !task.family || families.has(task.family)
      || typeof task.prompt !== 'string' || !task.prompt.trim() || !Array.isArray(task.acceptedForms) || !task.acceptedForms.length
      || task.acceptedForms.some(form => !forms.has(form)) || !Array.isArray(task.checks) || !task.checks.length) throw new Error('Invalid or duplicated development task');
    ids.add(task.id); families.add(task.family);
  }
  return suite;
}

export function runSlots(suite, repetitions = 3) {
  validateFirstTaskSuite(suite);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Repetitions must be 1..3');
  return Array.from({ length: repetitions }, (_, repetition) => suite.tasks.map(task => ({ id: `${task.id}-${repetition + 1}`, taskId: task.id, repetition: repetition + 1, status: 'pending' }))).flat();
}

export function generationEvidence(task, result) {
  const complete = result.status === 'completed', attempts = result.toolAttempts ?? [];
  const attemptsObserved = Array.isArray(result.toolAttempts);
  const observedForms = result.observedForms ?? [];
  const expectsUi = task.acceptedForms.some(form => form !== 'non-ui');
  const matching = complete && observedForms.length === 1 && task.acceptedForms.includes(observedForms[0]);
  const publications = [
    ...(result.journal?.records ?? []).filter(record => record.status === 'committed'),
    ...(result.components ?? []).filter(output => output.publication?.status === 'committed'),
  ];
  return {
    observedForms, expectsUi, uiAttempts: attemptsObserved ? attempts.length : null, publicationCount: publications.length,
    generationAccepted: expectsUi ? matching && publications.length > 0 : null,
    firstAttemptAccepted: expectsUi ? matching && !attempts[0]?.isError && publications.some(record => record.toolCallId === attempts[0]?.toolCallId) : null,
    noUiResponse: expectsUi ? null : complete && attemptsObserved && attempts.length === 0 && observedForms.length === 1 && observedForms[0] === 'non-ui' && !!result.finalText?.trim(),
    unexpectedUiAttempt: !expectsUi && attemptsObserved ? attempts.length > 0 : null,
    requestCount: result.requests?.length ?? 0,
    elapsedMs: result.endedAt && result.startedAt ? Date.parse(result.endedAt) - Date.parse(result.startedAt) : null,
    diagnostics: attempts.filter(attempt => attempt.isError).map(attempt => attempt.diagnostic),
    // Publication and response modality cannot establish semantic correctness.
    choiceCorrect: null, semanticCorrect: null, browserInteraction: null, savedAfterInteraction: null, reload: null, followup: null,
  };
}

export function summarizeRun(suite, slots) {
  const tasks = new Map(suite.tasks.map(task => [task.id, task]));
  const ui = slots.filter(slot => tasks.get(slot.taskId).acceptedForms.some(form => form !== 'non-ui'));
  const nonUi = slots.filter(slot => tasks.get(slot.taskId).acceptedForms.includes('non-ui'));
  return {
    requested: slots.length, finished: slots.filter(slot => ['completed', 'failed'].includes(slot.status)).length,
    failed: slots.filter(slot => slot.status === 'failed').length, pending: slots.filter(slot => slot.status === 'pending').length,
    ui: { denominator: ui.length, generationAccepted: ui.filter(slot => slot.evidence?.generationAccepted === true).length,
      firstAttemptAccepted: ui.filter(slot => slot.evidence?.firstAttemptAccepted === true).length },
    nonUi: { denominator: nonUi.length, responsesWithoutUi: nonUi.filter(slot => slot.evidence?.noUiResponse === true).length,
      unexpectedUiAttempts: nonUi.filter(slot => slot.evidence?.unexpectedUiAttempt === true).length },
    semanticAcceptance: 'pending', completeTaskAcceptance: 'pending',
    denominatorPolicy: 'Every scheduled repetition stays in its denominator, including errors, timeouts and unfinished slots.',
  };
}

/** Freeze relevant implementation, schemas, tool policy, model harness and SDK lock. */
export async function evaluationSources(root) {
  const paths = ['package-lock.json', 'extensions/piora-intelligent-ui.ts', 'extensions/piora-mini-app.ts',
    'scripts/probe-mini-app-generation.mjs', 'scripts/mini-app-evaluation-data.mjs', 'scripts/evaluate-mini-apps.mjs',
    'tests/fixtures/intelligent-ui/phase3-first-tasks.json'];
  for (const entry of await readdir(join(root, 'lib'), { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.ts')) paths.push(`lib/${entry.name}`);
  const collect = async directory => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) paths.push(path);
    }
  };
  await collect('lib/mini-app'); await collect('lib/intelligent-ui'); await collect('components/mini-app');
  const files = await Promise.all(paths.sort().map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
