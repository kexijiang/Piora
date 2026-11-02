/** Opt-in, resumable fixed-implementation generation baseline. Each sample owns
 * a fresh process/session; labels and oracles are never sent to the model. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { validateFirstTaskSuite, runSlots, generationEvidence, summarizeRun, evaluationSources } from './mini-app-evaluation-data.mjs';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
if (!args.includes('--run')) throw new Error('This invokes the configured DeepSeek V4.1 model; pass --run explicitly');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const repetitions = Number(option('--repetitions', '3')), concurrency = Number(option('--concurrency', '2'));
const thinking = option('--thinking', 'disabled');
if (!['disabled', 'enabled'].includes(thinking)) throw new Error('--thinking must be disabled or enabled');
if (![1, 2].includes(concurrency)) throw new Error('Concurrency must be one or two');
const suite = validateFirstTaskSuite(JSON.parse(await readFile(join(root, 'tests/fixtures/intelligent-ui/phase3-first-tasks.json'), 'utf8')));
const sources = await evaluationSources(root), resume = option('--resume', null);
await mkdir(join(root, '.verification'), { recursive: true });
const directory = resume ? resolve(root, resume) : await mkdtemp(join(root, '.verification', 'mini-app-evaluation-'));
if (!directory.startsWith(join(root, '.verification') + '\\') && !directory.startsWith(join(root, '.verification') + '/')) throw new Error('Evaluation output must stay in this worktree .verification directory');
const manifestPath = join(directory, 'result.json');
const manifest = resume ? JSON.parse(await readFile(manifestPath, 'utf8')) : {
  version: 1, suiteVersion: suite.version, split: 'development', startedAt: new Date().toISOString(),
  scope: 'production SDK generation/admission/publication; no browser interaction, edited-state saving or semantic acceptance',
  model: { provider: 'deepseek', id: 'deepseek-flash', configuredNameRequirement: 'V4.1', fallback: false },
  maxTokens: 32768, reasoning: thinking === 'enabled' ? 'medium' : 'off', thinking, repetitions, sources, slots: runSlots(suite, repetitions),
};
if (manifest.sources.sha256 !== sources.sha256) throw new Error('Implementation changed; keep the old baseline and start a new run');
if (manifest.thinking !== thinking) throw new Error('Thinking setting changed; do not combine configurations in one run');
if (manifest.slots.some(slot => slot.status === 'running')) throw new Error('A prior process owns an unfinished slot. Inspect its process and result before deciding how to recover; do not replay it automatically');
let writes = Promise.resolve();
function save() {
  manifest.summary = summarizeRun(suite, manifest.slots);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  writes = writes.then(() => writeFile(manifestPath, text)); return writes;
}
await save(); console.log(JSON.stringify({ directory, requested: manifest.slots.length, sourceSha256: sources.sha256 }));
let invalidated = false;
async function sample(slot) {
  if ((await evaluationSources(root)).sha256 !== sources.sha256) { invalidated = true; throw new Error('Implementation changed during evaluation'); }
  slot.status = 'running'; slot.startedAt = new Date().toISOString(); await save();
  const task = suite.tasks.find(task => task.id === slot.taskId);
  const child = spawn(process.execPath, [join(root, 'scripts/probe-mini-app-generation.mjs'), slot.taskId, '32768', '--thinking', thinking], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  slot.pid = child.pid; await save();
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300_000);
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2 * 1024 * 1024); });
  const exit = await new Promise(resolveExit => {
    child.once('error', error => resolveExit({ error: error.message }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  const log = join(directory, `${slot.id}.log`); await writeFile(log, stdout + '\n' + stderr);
  slot.exit = exit; slot.timedOut = timedOut; slot.log = relative(root, log);
  try {
    const outputs = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const location = outputs.find(output => output.case === slot.taskId && output.directory)?.directory;
    if (!location || !resolve(location).startsWith(join(root, '.verification', 'mini-app-live-'))) throw new Error('Probe did not provide its isolated result directory');
    const path = join(location, 'result.json'), result = JSON.parse(await readFile(path, 'utf8'));
    slot.result = relative(root, path); slot.evidence = generationEvidence(task, result);
    slot.status = !timedOut && exit.code === 0 && result.status === 'completed' ? 'completed' : 'failed';
    slot.reportedOutcome = result.outcome; slot.finalText = result.finalText ?? null;
    slot.providerModelIds = result.providerModelIds; slot.error = result.error ?? null;
    slot.thinkingPinned = result.requests?.length > 0 && result.requests.every(request => request.generationSettings?.thinking?.type === thinking);
    if (!slot.thinkingPinned) { slot.status = 'failed'; slot.error = 'Requested thinking setting was not verified'; }
  } catch (error) { slot.status = 'failed'; slot.error = error.message; }
  slot.endedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ id: slot.id, status: slot.status, outcome: slot.reportedOutcome, evidence: slot.evidence, result: slot.result }));
}
const pending = manifest.slots.filter(slot => slot.status === 'pending');
const workers = Array.from({ length: concurrency }, async () => {
  while (pending.length && !invalidated) {
    const slot = pending.shift();
    try { await sample(slot); } catch (error) { manifest.error = error.message; invalidated = true; }
  }
});
await Promise.all(workers);
manifest.endedAt = new Date().toISOString();
manifest.sourceUnchanged = (await evaluationSources(root)).sha256 === sources.sha256;
manifest.status = invalidated || !manifest.sourceUnchanged ? 'invalidated' : manifest.slots.some(slot => slot.status === 'pending' || slot.status === 'running') ? 'incomplete' : 'completed';
await save();
console.log(JSON.stringify({ directory, status: manifest.status, summary: manifest.summary }));
if (manifest.status !== 'completed') process.exitCode = 1;
