import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { startRealModelProxy } from './desktop-e2e/real-model-proxy.mjs';

// Opt-in development repair trajectory. Original generation remains untouched;
// all edits, revision decisions and subsequent task operations use the real UI.
const root = process.cwd(), args = process.argv.slice(2), index = args.indexOf('--bindings');
const { answerOutputMiniAppPublicationPath } = await createJiti(import.meta.url).import('../lib/answer-output-paths.ts');
assert.ok(index >= 0 && args[index + 1], 'Explicit --bindings <json> is required');
const bindingsPath = resolve(args[index + 1]);
const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
assert.equal(bindings.version, 1); assert.equal(bindings.thinking, 'enabled');
assert.equal(bindings.scenario, 'jug-no-op-revision');
assert.ok(bindings.cancelFirst === undefined || typeof bindings.cancelFirst === 'boolean');
assert.ok(bindings.staleReview === undefined || typeof bindings.staleReview === 'boolean');
const sourcePath = resolve(bindings.source), bytes = await readFile(sourcePath);
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(bytes), bindings.sha256);
const original = JSON.parse(bytes), record = original.journal.records.find(r => r.status === 'committed');
assert.equal(original.status, 'completed'); assert.ok(record);
const sourceJournal = JSON.parse(await readFile(answerOutputMiniAppPublicationPath(original.sessionId, join(dirname(sourcePath), 'agent')), 'utf8'));
assert.equal(sourceJournal.sessionId, original.sessionId);
assert.equal(sourceJournal.records.find(r => r.toolCallId === record.toolCallId)?.planDigest, record.planDigest, 'Original sidecar must match the recorded program');
const cancel = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancel.abort(new Error(name)));
const userAgent = getAgentDir();
const runtime = await ModelRuntime.create({ authPath: join(userAgent, 'auth.json'), modelsPath: join(userAgent, 'models.json'), allowModelNetwork: false });
const model = runtime.getModel('deepseek', 'deepseek-flash');
assert.ok(model && /V4\.1/.test(model.name) && runtime.hasConfiguredAuth('deepseek'));
const repairPrompt = '刚才两个杯子都是空的时候，点5升杯倒进3升杯，居然说3升杯已经满了。把这种无效操作的提示修好，反过来倒也检查一下。其他规则和界面照旧，我现在的水量和操作记录要保留。';
const followupPrompt = '现在两个杯子各有多少水，还算量出4升了吗？只解释当前状态。';
let directory, currentPrompt, phase = 'prepare';
const requests = [], responses = [], checkpoints = [], observations = [], decisions = [];
const report = { version: 1, bindings: bindingsPath, scope: 'Real model revision of a copied synthetic original session; trusted UI operations and explicit migration; not new-task generation or independent human acceptance', source: bindings.source, sourceSha256: bindings.sha256, model: { provider: model.provider, id: model.id, name: model.name, thinking: 'enabled', fallback: false }, status: 'running', semanticReview: 'pending', requests, responses, checkpoints, observations, decisions };
const persist = () => writeFile(join(directory, 'revision-replay.json'), JSON.stringify(report, null, 2) + '\n');
const parts = message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text);
const scenario = {
  id: 'recorded-mini-app-revision', mode: 'real-model-repair-and-migration',
  scope: report.scope,
  coverage: ['original no-op defect', 'saved nonzero task progress', 'real natural-language repair', 'candidate does not replace source', 'explicit progress migration', 'empty/full no-op explanations', 'goal and non-goal states', 'reload and real follow-up'],
  limits: ['two-human semantic acceptance', 'all revisions', 'all generated layouts', 'other platforms', 'release packages'],
  async prepare(context) {
    directory = context.directory;
    const source = join(dirname(sourcePath), 'agent');
    await cp(join(source, 'sessions'), join(context.paths.agent, 'sessions'), { recursive: true, force: false, errorOnExist: true });
    for (const name of ['intelligent-ui', 'mini-app']) {
      const destination = join(context.paths.agent, 'piora', name); await mkdir(destination, { recursive: true });
      for (const file of await readdir(join(source, 'piora', name))) if (file.endsWith('.json')) await cp(join(source, 'piora', name, file), join(destination, file), { force: false, errorOnExist: true });
    }
    await writeFile(join(context.paths.agent, 'piora', 'beta-features.json'), JSON.stringify({ version: 1, intelligentUi: true }));
    const relay = await startRealModelProxy({ runtime, model, signal: context.signal, registerCleanup: context.registerCleanup,
      onRequest: async ({ id, body }) => {
        assert.equal(body.model, 'deepseek-flash');
        const texts = (body.messages ?? []).flatMap(parts), task = !!currentPrompt && texts.includes(currentPrompt);
        if (task) assert.equal(body.thinking?.type, 'enabled');
        const start = (body.messages ?? []).findLastIndex(m => parts(m).includes(currentPrompt));
        requests.push({ id, phase, purpose: task ? 'task' : 'background', model: body.model, thinking: body.thinking,
          savedContext: texts.filter(t => t.startsWith('Saved mini app parameters')),
          calls: start >= 0 ? body.messages.slice(start + 1).flatMap(m => m.tool_calls ?? []).map(c => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })) : [], digest: sha(JSON.stringify(body)) });
        await persist();
      },
      onResponse: async response => {
        assert.ok(!(response.modelIds ?? []).some(id => /pro/i.test(id)), 'No Pro response');
        const request = requests.find(r => r.id === response.id);
        responses.push({ ...response, phase: request?.phase, purpose: request?.purpose }); await persist();
      },
    });
    await writeFile(join(context.paths.agent, 'models.json'), JSON.stringify({ providers: { deepseek: { api: model.api, ...relay,
      models: [{ id: model.id, name: model.name, reasoning: model.reasoning, compat: model.compat, input: ['text'], contextWindow: model.contextWindow, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(join(context.paths.agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false }, defaultProvider: model.provider, defaultModel: model.id, enabledModels: [`${model.provider}/${model.id}`], defaultThinkingLevel: 'medium' }));
    context.report.credentials = 'Memory-only pinned provider relay; disposable loopback token in isolated profile';
    await persist();
  },
  async run({ page, origin, step, waitUntil, reload, screenshot }) {
    const surfaceFor = entryId => page.locator(`[data-chat-entry-id="${entryId}"] [data-mini-app-surface]`);
    const sourceSurface = surfaceFor(record.call.id);
    // Long chats unmount offscreen rows. Scroll the actual chat UI until the
    // precise original entry is mounted; a visible cancelled card is not it.
    const reveal = async (surface, direction = 'up', scope = page) => {
      const scroll = scope.locator('#chat-scroll-container');
      await scroll.hover({ position: { x: 8, y: 8 } });
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await surface.count() === 1) { await surface.scrollIntoViewIfNeeded(); return; }
        await page.mouse.wheel(0, direction === 'up' ? -650 : 650);
        await page.waitForTimeout(60);
      }
      assert.fail('Expected original conversation entry did not mount after bounded UI scrolling');
    };
    const frame = surface => surface.frameLocator('iframe[title="Interactive answer"]');
    const read = async callId => page.evaluate(async endpoint => {
      const r = await fetch(endpoint, { cache: 'no-store' }); if (!r.ok) throw new Error(`Read ${r.status}`); return r.json();
    }, `/api/sessions/${original.sessionId}/mini-app?toolCallId=${encodeURIComponent(callId)}`);
    const healthy = async surface => {
      const errors = await surface.evaluate(node => ['runtime', 'state', 'action'].map(kind => [kind, node.getAttribute(`data-mini-app-${kind}-error`)]).filter(([, value]) => value));
      assert.deepEqual(errors, [], 'No host error');
    };
    const ready = async (surface, direction = 'up', scope = page) => {
      await reveal(surface, direction, scope);
      await waitUntil(async () => { await healthy(surface); return frame(surface).locator('body').isVisible(); }, 'interactive surface ready');
    };
    const save = async (surface, callId, label) => {
      await healthy(surface); const button = surface.getByRole('button', { name: /^(Save|保存)$/ }); await button.click();
      await waitUntil(async () => {
        await healthy(surface);
        return await button.isEnabled() && surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).isVisible();
      }, 'saved state acknowledged');
      const saved = await read(callId); checkpoints.push({ label, saved, uiText: await frame(surface).locator('body').innerText() }); await persist(); return saved;
    };
    const check = (saved, j3, j5, steps) => {
      // A narrowly scoped message-only repair should preserve the original
      // state contract. Schema redesign needs a separately reviewed binding.
      assert.equal(saved.result.snapshot.state.j3, j3); assert.equal(saved.result.snapshot.state.j5, j5);
      if (steps !== undefined) assert.equal(saved.result.snapshot.state.steps, steps);
    };
    const click = async (surface, callId, id, expected, label) => {
      await frame(surface).locator(`[data-event="${id}"]`).click();
      const saved = await save(surface, callId, label); check(saved, ...expected); return saved;
    };
    const send = async (prompt, nextPhase) => {
      phase = nextPhase; currentPrompt = prompt; const before = responses.length;
      await page.locator('textarea').first().fill(prompt); await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
      const relevant = () => responses.slice(before).filter(r => r.purpose === 'task' && r.phase === nextPhase);
      await waitUntil(() => { assert.ok(!relevant().some(r => r.status !== 200), 'Provider request failed'); return relevant().some(r => r.text && r.finishReasons?.includes('stop')); }, 'real model final response');
      await waitUntil(() => page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible(), 'turn ended');
      await waitUntil(async () => await page.locator('[data-answer-output-interaction-paused]').count() === 0, 'answer synchronization ended');
      return relevant().map(r => r.text ?? '').join('\n');
    };
    page.on('response', response => {
      const request = response.request(), url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.includes(`/sessions/${original.sessionId}/mini-app`)) return;
      if (request.method() === 'POST' && url.pathname.endsWith('/migration')) decisions.push({ status: response.status(), choice: request.postDataJSON() });
      if (response.status() >= 400) observations.push({ phase, method: request.method(), path: url.pathname, status: response.status() });
    });
    let baseline, candidateCall, candidateSurface;
    const propose = async (prompt, nextPhase) => {
      const answer = await send(prompt, nextPhase);
      (report.repairAnswers ??= []).push({ phase: nextPhase, answer }); await persist();
      const calls = [...new Map(requests.filter(r => r.phase === nextPhase && r.purpose === 'task').flatMap(r => r.calls).map(c => [c.id, c])).values()];
      assert.ok(calls.every(c => ['piora_render_mini_app', 'piora_inspect_mini_app'].includes(c.name)), 'Repair uses local UI tools only');
      const proposals = calls.filter(c => c.name === 'piora_render_mini_app'); assert.ok(proposals.length > 0, 'A real repair candidate is required');
      candidateCall = proposals.at(-1).id; report.candidateCall = candidateCall;
      const pending = await read(candidateCall); (report.candidates ??= []).push(pending);
      assert.equal(pending.plan.id, record.plan.id, 'Same task retains identity');
      assert.equal(pending.publication.status, 'awaiting_confirmation');
      assert.equal(pending.plan.migration?.fromPlanDigest, baseline.publication.planDigest, 'Progress migration binds original plan');
      assert.deepEqual((await read(record.toolCallId)).result.snapshot, baseline.result.snapshot, 'Unconfirmed repair preserves source');
      const journal = JSON.parse(await readFile(answerOutputMiniAppPublicationPath(original.sessionId, join(directory, 'agent')), 'utf8'));
      const candidateRecord = journal.records.find(r => r.toolCallId === candidateCall); assert.ok(candidateRecord);
      candidateSurface = surfaceFor(candidateRecord.call.id);
      await reveal(candidateSurface, 'down');
      assert.equal(await candidateSurface.count(), 1);
      await candidateSurface.getByText('初始预览 · 尚未应用', { exact: true }).waitFor();
      await candidateSurface.getByText('这份预览尚未替换当前版本或进度。', { exact: true }).waitFor();
      await screenshot(`${nextPhase}-awaiting-confirmation.png`); await persist();
    };
    try {
      await step('reproduce-original-defect-and-save-progress', async () => {
        await page.goto(`${origin}/?session=${original.sessionId}`, { waitUntil: 'domcontentloaded' }); await ready(sourceSurface);
        const noOp = await click(sourceSurface, record.toolCallId, 'pour5to3', [0, 0, 0], 'original-empty-no-op');
        assert.match(noOp.result.snapshot.state.note, /3\s*升杯已经满/);
        for (const [id, values] of [['fill5',[0,5,1]],['pour5to3',[3,2,2]],['empty3',[0,2,3]],['pour5to3',[2,0,4]],['fill5',[2,5,5]],['pour5to3',[3,4,6]]]) await click(sourceSurface, record.toolCallId, id, values, `original-${id}-${values[2]}`);
        baseline = await read(record.toolCallId); await screenshot('original-goal.png');
      });
      await step('real-model-proposes-a-source-bound-repair', async () => {
        await propose(repairPrompt, 'repair');
      });
      if (bindings.cancelFirst) await step('cancel-then-request-another-real-revision', async () => {
        const cancelledCall = candidateCall;
        await candidateSurface.getByRole('button', { name: /^(Review changes \/ refresh|核对变化 \/ 刷新)$/ }).click();
        await candidateSurface.getByRole('button', { name: /^(Cancel revision|取消这次变更)$/ }).click();
        await candidateSurface.getByText(/^(This version was not published|此版本未发布)$/).waitFor();
        report.cancelled = await read(cancelledCall);
        assert.equal(report.cancelled.publication.status, 'aborted');
        assert.deepEqual((await read(record.toolCallId)).result.snapshot, baseline.result.snapshot);
        await reload(); await ready(sourceSurface);
        assert.deepEqual((await read(record.toolCallId)).result.snapshot, baseline.result.snapshot);
        await propose('刚才那份修改我取消了。现在还是要修好两个方向倒水时的错误提示，其他规则和界面照旧，保留我现在的水量、步数和操作记录。', 'repair-after-cancel');
        assert.notEqual(candidateCall, cancelledCall);
      });
      await step('explicitly-confirm-and-preserve-current-progress', async () => {
        await candidateSurface.getByRole('button', { name: /^(Review changes \/ refresh|核对变化 \/ 刷新)$/ }).click();
        await candidateSurface.getByRole('combobox', { name: /^(Task progress|任务进度)$/ }).selectOption('migrate');
        if (bindings.staleReview) {
          // Prepare a second same-origin application view, not another native
          // window. Its own React/IndexedDB clients let the original review
          // stay mounted while all task edits still use trusted UI input.
          report.secondaryView = 'Test-mounted same-origin application iframe in the same Electron profile; not native multi-window acceptance';
          await page.evaluate(url => {
            const view = document.createElement('iframe'); view.dataset.revisionTestView = '';
            view.title = 'Secondary revision test view'; view.src = url;
            Object.assign(view.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '2147483647', border: '0', background: 'white' });
            document.body.append(view);
          }, `${origin}/?session=${original.sessionId}`);
          try {
            const other = page.frameLocator('iframe[data-revision-test-view]');
            await other.locator('.app-shell').waitFor();
            const otherSource = other.locator(`[data-chat-entry-id="${record.call.id}"] [data-mini-app-surface]`);
            await ready(otherSource, 'up', other);
            baseline = await click(otherSource, record.toolCallId, 'fill5', [3,5,7], 'edit-source-during-review');
          } finally { await page.locator('iframe[data-revision-test-view]').evaluate(node => node.remove()); }
          assert.equal(await candidateSurface.getByRole('combobox', { name: /^(Task progress|任务进度)$/ }).inputValue(), 'migrate', 'Original review remained mounted with its chosen mode');
          await candidateSurface.getByRole('button', { name: /^(Confirm revision and migrate progress|确认新版并迁移进度)$/ }).click();
          await candidateSurface.getByRole('alert').waitFor();
          assert.equal((await read(candidateCall)).publication.status, 'awaiting_confirmation');
          assert.deepEqual((await read(record.toolCallId)).result.snapshot, baseline.result.snapshot);
          await waitUntil(() => decisions.some(d => d.status === 409), 'stale confirmation rejected');
          await screenshot('repair-stale-review.png');
          await candidateSurface.getByRole('button', { name: /^(Review changes \/ refresh|核对变化 \/ 刷新)$/ }).click();
          await candidateSurface.getByRole('combobox', { name: /^(Task progress|任务进度)$/ }).selectOption('migrate');
        }
        await candidateSurface.getByRole('button', { name: /^(Confirm revision and migrate progress|确认新版并迁移进度)$/ }).click();
        await ready(candidateSurface, 'down');
        const migrated = await save(candidateSurface, candidateCall, 'migrated'); check(migrated, baseline.result.snapshot.state.j3, baseline.result.snapshot.state.j5, baseline.result.snapshot.state.steps);
        assert.equal(await candidateSurface.getByText('初始预览 · 尚未应用', { exact: true }).count(), 0);
        assert.deepEqual(migrated.result.snapshot.state.history, baseline.result.snapshot.state.history, 'Retain operation history');
        assert.equal(migrated.result.snapshot.tick, baseline.result.snapshot.tick); assert.equal(migrated.result.snapshot.rng, baseline.result.snapshot.rng);
        const old = await read(record.toolCallId); assert.equal(old.writable, false); assert.deepEqual(old.result.snapshot, baseline.result.snapshot);
        await reload(); await ready(candidateSurface); const restored = await read(candidateCall); assert.deepEqual(restored.result.snapshot, migrated.result.snapshot);
        await screenshot('repair-migrated.png');
      });
      await step('check-no-op-reasons-and-unchanged-game-rules', async () => {
        await click(candidateSurface, candidateCall, 'reset', [0,0,0], 'reset');
        const empty5 = await click(candidateSurface, candidateCall, 'pour5to3', [0,0,0], 'empty-source-5');
        const empty3 = await click(candidateSurface, candidateCall, 'pour3to5', [0,0,0], 'empty-source-3');
        report.noOpReasons = { empty5: empty5.result.snapshot.state.note, empty3: empty3.result.snapshot.state.note };
        assert.match(report.noOpReasons.empty5, /5\s*升[\s\S]*(空|没有水|没水)/); assert.doesNotMatch(report.noOpReasons.empty5, /3\s*升[\s\S]*满/);
        assert.match(report.noOpReasons.empty3, /3\s*升[\s\S]*(空|没有水|没水)/); assert.doesNotMatch(report.noOpReasons.empty3, /5\s*升[\s\S]*满/);
        await click(candidateSurface, candidateCall, 'fill3', [3,0,1], 'fill3'); await click(candidateSurface, candidateCall, 'fill5', [3,5,2], 'fill5');
        const full3 = await click(candidateSurface, candidateCall, 'pour5to3', [3,5,2], 'full-target-3');
        const full5 = await click(candidateSurface, candidateCall, 'pour3to5', [3,5,2], 'full-target-5');
        report.noOpReasons.full3 = full3.result.snapshot.state.note; report.noOpReasons.full5 = full5.result.snapshot.state.note;
        assert.match(report.noOpReasons.full3, /3\s*升[\s\S]*满/); assert.match(report.noOpReasons.full5, /5\s*升[\s\S]*满/);
        await click(candidateSurface, candidateCall, 'reset', [0,0,0], 'reset-again');
        for (const [id, values] of [['fill5',[0,5,1]],['pour5to3',[3,2,2]],['empty3',[0,2,3]],['pour5to3',[2,0,4]],['fill5',[2,5,5]],['pour5to3',[3,4,6]],['fill5',[3,5,7]]]) await click(candidateSurface, candidateCall, id, values, `repaired-${id}-${values[2]}`);
        const before = await read(candidateCall); await reload(); await ready(candidateSurface); assert.deepEqual((await read(candidateCall)).result.snapshot, before.result.snapshot);
        await screenshot('repair-operated.png');
      });
      await step('real-follow-up-keeps-repaired-state', async () => {
        const before = await read(candidateCall); report.followupAnswer = await send(followupPrompt, 'follow-up');
        const calls = requests.filter(r => r.phase === 'follow-up' && r.purpose === 'task').flatMap(r => r.calls); assert.equal(calls.length, 0, 'Current-state explanation needs no tools');
        const after = await read(candidateCall); assert.deepEqual(after.result.snapshot, before.result.snapshot); assert.equal(after.stateRevision, before.stateRevision);
        await screenshot('repair-followup.png');
      });
      report.status = 'completed';
    } catch (error) { report.status = 'failed'; report.error = error.message; await screenshot('repair-failure.png').catch(() => {}); throw error; }
    finally { assert.equal(sha(await readFile(sourcePath)), bindings.sha256); await persist(); }
  },
};
const result = await runDesktopScenario({ root, scenario, signal: cancel.signal, timeoutMs: 900_000, stepTimeoutMs: 240_000 });
console.log(JSON.stringify({ directory: result.directory, status: result.report.status, task: report.status, error: report.error, cleanupErrors: result.report.cleanupErrors }));
if (result.report.status !== 'passed') process.exitCode = 1;
