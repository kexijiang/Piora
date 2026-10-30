import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createEvaluationManifest, sha256 } from './intelligent-ui/evaluation.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const script = join(cwd, 'scripts/check-intelligent-ui-calculations.mjs');
const surface = { version: 1, revision: 1, id: 'bill', title: 'Bill', nodes: [
  { id: 'people', type: 'number', label: 'People', value: 6 },
  { id: 'result', type: 'metric', label: 'Share', value: { op: 'divide', args: [480, { ref: 'people' }] } },
] };
async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'piora-calculation-report-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const suite = { version: 'test', capabilityVersion: 'test', tasks: ['one', 'two'].map(id => ({
    id, family: id, domain: id, split: 'heldout', label: 'ui', turns: [{ user: 'Split this bill' }], checks: ['80 then 60'],
  })) };
  change(suite);
  const manifest = createEvaluationManifest(suite, { models: ['provider/test'], policyVersions: ['phase1','plan-2'], split: 'heldout', repetitions: 1, baselineSha256: 'a'.repeat(64) });
  const manifestText = JSON.stringify(manifest);
  const oracles = { cases: suite.tasks.map(task => ({ taskId: task.id, controls: { people: { type: 'number', initial: 6 } },
    steps: [{}, { people: 8 }], expected: [[80, 60]] })) };
  const runs = suite.tasks.flatMap(task => manifest.policyVersions.map(policyVersion => ({ taskId: task.id,
    model: manifest.models[0], policyVersion, repetition: 1, outcome: 'completed', durationMs: 10,
    turns: task.turns.map(turn => ({ user: turn.user, assistant: 'answer', durationMs: 10,
      uiAttempts: policyVersion === 'phase1' && task.id === 'two' ? [] : [{ toolCallId: task.id, toolName: 'piora_render_ui', committed: false,
        evidence: { generationValid: policyVersion === 'plan-2', surface } }] })),
  })));
  for (const [name, content] of [['manifest.json',manifestText], ['manifest.sha256',sha256(manifestText)], ['suite.json',JSON.stringify(suite)],
    ['oracles.json',JSON.stringify(oracles)], ['runs.jsonl',runs.map(r=>JSON.stringify(r)).join('\n')]]) await writeFile(join(root,name),content);
  const args = ['--directory',root,'--output',join(root,'report.json'),'--suite',join(root,'suite.json'),'--oracles',join(root,'oracles.json')];
  return { root, args, oracles, manifest, runs, cli: (...values) => spawnSync(process.execPath,[script,...values],{cwd,encoding:'utf8',windowsHide:true}),
    write: (name,value) => writeFile(join(root,name),JSON.stringify(value)) };
}
test('explicit heldout calculation report keeps failed generations, misses and policy groups in denominators', async t => {
  const f = await fixture(t), result = f.cli(...f.args);
  assert.equal(result.status,0,result.stderr);
  const report = JSON.parse(await readFile(join(f.root,'report.json'),'utf8'));
  assert.equal(report.split,'heldout'); assert.equal(report.denominator,4);
  assert.deepEqual(report.first,{'invalid-generation':1,matched:2,'no-ui':1});
  assert.deepEqual(report.groups.map(g=>({policy:g.policyVersion,n:g.denominator,final:g.final})),[
    {policy:'phase1',n:2,final:{'invalid-generation':1,'no-ui':1}}, {policy:'plan-2',n:2,final:{matched:2}},
  ]);
  assert.equal(report.manifestSha256,sha256(await readFile(join(f.root,'manifest.json'),'utf8')));
  const before = await readFile(join(f.root,'report.json'),'utf8');
  assert.notEqual(f.cli(...f.args).status,0,'existing report must not be overwritten');
  assert.equal(await readFile(join(f.root,'report.json'),'utf8'),before);
});
test('omitting, duplicating or adding oracle tasks cannot remove failures from the report', async t => {
  const f = await fixture(t);
  await f.write('oracles.json',{cases:[f.oracles.cases[0]]});
  assert.match(f.cli(...f.args).stderr,/cover every selected UI task/);
  await f.write('oracles.json',{cases:[...f.oracles.cases,f.oracles.cases[0]]});
  assert.match(f.cli(...f.args).stderr,/Duplicate oracle/);
  await f.write('oracles.json',{cases:[...f.oracles.cases,{...f.oracles.cases[0],taskId:'unplanned'}]});
  assert.match(f.cli(...f.args).stderr,/cover every selected UI task/);
});
test('changed frozen manifest, wrong suite and incomplete runs are rejected', async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.root,'manifest.json'),'utf8');
  await f.write('manifest.json',{...f.manifest,split:'development'});
  assert.match(f.cli(...f.args).stderr,/Frozen manifest changed/);
  await writeFile(join(f.root,'manifest.json'),original);
  const suite = JSON.parse(await readFile(join(f.root,'suite.json'),'utf8'));
  await f.write('suite.json',{...suite,version:'changed'});
  assert.match(f.cli(...f.args).stderr,/Suite differs/);
  await f.write('suite.json',suite);
  await writeFile(join(f.root,'runs.jsonl'),f.runs.slice(1).map(r=>JSON.stringify(r)).join('\n'));
  assert.match(f.cli(...f.args).stderr,/complete frozen run/);
});
test('multi-turn tasks cannot silently score only the first UI turn', async t => {
  const f = await fixture(t,suite => { suite.tasks[0].turns=[{user:'First',label:'ui'},{user:'Second',label:'ui'}]; });
  assert.match(f.cli(...f.args).stderr,/Multiple UI turns require separate per-turn oracles/);
});
test('multi-turn labels and explicit suite/oracle pairing are mandatory', async t => {
  const f = await fixture(t,suite => { suite.tasks[0].turns=[{user:'First'},{user:'Second'}]; });
  assert.match(f.cli(...f.args).stderr,/explicit turn labels/);
  assert.match(f.cli(...f.args.slice(0,-2)).stderr,/supplied together/);
});
