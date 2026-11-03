/** Post-process a completed frozen run. Never makes model requests or changes run records. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkCalculationAttempts } from '../lib/intelligent-ui/calculation-oracle.mjs';
import { summarizeEvaluation } from '../lib/intelligent-ui/evaluation.mjs';
const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--directory', '--output', '--suite', '--oracles'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) throw new Error('Use --directory <completed-run-directory> --output <new-file> [--suite <suite.json> --oracles <oracles.json>]');
  options.set(args[i], args[i + 1]);
}
if (!options.has('--directory') || !options.has('--output')) throw new Error('Both directory and output are required');
if (options.has('--suite') !== options.has('--oracles')) throw new Error('Explicit suite and oracles must be supplied together');
const explicit = options.has('--suite');
const directory = resolve(options.get('--directory'));
const oracleText = await readFile(options.get('--oracles') ?? 'tests/fixtures/intelligent-ui/development-calculation-oracles.json', 'utf8');
const suite = JSON.parse(await readFile(options.get('--suite') ?? 'tests/fixtures/intelligent-ui/evaluation-cases.json', 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8');
if (hash(manifestText) !== (await readFile(join(directory, 'manifest.sha256'), 'utf8')).trim()) throw new Error('Frozen manifest changed');
const manifest = JSON.parse(manifestText);
const raw = await readFile(join(directory, 'runs.jsonl'), 'utf8'), runs = raw.trim().split(/\r?\n/).map(JSON.parse);
if ((!explicit && manifest.split !== 'development') || !summarizeEvaluation(suite, manifest, runs).complete) throw new Error('A complete frozen run with its matching suite is required');
const oracleFile = JSON.parse(oracleText);
if (!Array.isArray(oracleFile.cases)) throw new Error('Oracle file requires cases');
const oracles = new Map(oracleFile.cases.map(oracle => [oracle.taskId, oracle]));
if (oracles.size !== oracleFile.cases.length) throw new Error('Duplicate oracle task ID');
const tasks = suite.tasks.filter(task => manifest.taskIds.includes(task.id));
if (tasks.some(task => task.turns.length > 1 && task.turns.some(turn => !turn.label))) throw new Error('Multi-turn calculations require explicit turn labels');
const uiTurns = task => task.turns.flatMap((turn, index) => (turn.label ?? task.label) === 'ui' ? [index] : []);
if (tasks.some(task => uiTurns(task).length > 1)) throw new Error('Multiple UI turns require separate per-turn oracles');
const expected = tasks.filter(task => uiTurns(task).length).map(task => task.id);
if (expected.length !== oracles.size || expected.some(id => !oracles.has(id))) throw new Error('Oracles must cover every selected UI task exactly once');
const records = runs.filter(run => oracles.has(run.taskId)).map(run => {
  const oracle = oracles.get(run.taskId), task = suite.tasks.find(task => task.id === run.taskId);
  const uiTurnIndex = uiTurns(task)[0];
  const attempts = run.turns[uiTurnIndex]?.uiAttempts ?? [];
  return { taskId: run.taskId, model: run.model, policyVersion: run.policyVersion, repetition: run.repetition, outcome: run.outcome,
    ...checkCalculationAttempts(attempts, oracle) };
});
const counts = (key, rows = records) => Object.fromEntries([...new Set(rows.map(r => r.outcome === 'completed' ? r[key].status : 'run-incomplete'))]
  .map(status => [status, rows.filter(r => (r.outcome === 'completed' ? r[key].status : 'run-incomplete') === status).length]));
const groups = manifest.models.flatMap(model => manifest.policyVersions.map(policyVersion => {
  const rows = records.filter(r => r.model === model && r.policyVersion === policyVersion);
  return { model, policyVersion, denominator: rows.length, first: counts('first', rows), final: counts('final', rows) };
}));
const report = { version: 3, scope: 'offline-numeric-trajectories', suiteSha256: manifest.suiteSha256, split: manifest.split,
  manifestSha256: hash(manifestText), oracleSha256: hash(oracleText), runsSha256: hash(raw),
  checkerSha256: hash(await readFile(new URL('../lib/intelligent-ui/calculation-oracle.mjs', import.meta.url), 'utf8')),
  scriptSha256: hash(await readFile(new URL(import.meta.url), 'utf8')),
  chronology: explicit ? 'Explicit oracle file; its contents and hash must be compared with the separately frozen evaluation plan. This checker alone does not establish when expectations were authored.' : 'Oracles derive from existing development checks; authored after the phase1 baseline, desktop probes and inspection of the first candidate d01. This is not a preregistered semantic test.',
  limitations: 'A match only demonstrates numeric expression trajectories with unique control mapping. It does not verify labels, UI selection, all boundary cases, presentation, browser interaction, persistence or followups. Unmapped controls require review and are not successes.',
  denominator: records.length, first: counts('first'), final: counts('final'), groups, records };
await writeFile(resolve(options.get('--output')), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ denominator: report.denominator, first: report.first, final: report.final, groups }));
