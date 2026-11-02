import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { counterPlan } from '../../../lib/mini-app-fixtures.mjs';

const provider = 'desktop-recovery-fixture', model = 'recovery-fixture';
const texts = message => typeof message.content === 'string' ? [message.content]
  : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text);
const savedApp = messages => {
  const text = messages.flatMap(texts).findLast(value => value.startsWith('Saved mini app parameters and host publication results'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)).apps.find(app => app.id === 'counter') : undefined;
};

export const intelligentUiRecovery = {
  id: 'intelligent-ui-recovery', mode: 'local-model-fixture',
  scope: 'real Electron/Next chat, production save receipts and revision confirmation; deterministic local model and one lost-response transport fixture',
  coverage: ['successful save with lost response', 'reload and receipt recovery without duplicate write', 'cancel candidate then request another revision', 'stale review rejected after UI edit', 'refresh review and explicitly migrate progress', 'reload, further edit and saved-context follow-up'],
  limits: ['real model quality', 'two native windows', 'native minimize/hide/restore', 'fork/duplicate/export/trash combinations', 'packaged builds and other platforms'],
  async prepare({ paths, report, registerCleanup }) {
    const root = resolve(import.meta.dirname, '../../..'), jiti = createJiti(import.meta.url, { alias: { '@': root } });
    const { compileMiniAppPlan } = await jiti.import(join(root, 'lib/mini-app/plan.ts'));
    const { answerDataDigest } = await jiti.import(join(root, 'lib/answer-output-receipts.ts'));
    const initial = counterPlan(); initial.playback = { mode: 'none' }; initial.title = 'Recovery counter';
    const cancelled = { ...initial, title: 'Cancelled revision' };
    const migrated = { ...initial, title: 'Progress revision', migration: {
      fromPlanDigest: answerDataDigest(compileMiniAppPlan(initial).plan),
      description: 'Preserve count relative to the starting value', clock: 'preserve',
    }, program: initial.program + '\nfunction migrate(previous,inputs){return {count:previous.state.count+inputs.start-previous.inputs.start};}' };
    const plans = { create: initial, cancel: cancelled, migrate: migrated }, requests = [];
    report.credentials = 'synthetic-local-fixture-only; no user credentials';
    report.fixture = { provider, model, requests, transport: 'One successful production PUT response replaced with malformed JSON after commit; no checkpoint or receipt is injected' };
    this.report = report;
    const server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()), messages = body.messages ?? [];
        const prompt = messages.filter(message => message.role === 'user').flatMap(texts).findLast(value => value.startsWith('Recovery fixture:')) ?? '';
        const kind = Object.keys(plans).find(key => prompt === `Recovery fixture: ${key}`), callId = kind ? `recovery-${kind}` : undefined;
        const create = !!kind && !messages.some(message => message.role === 'tool' && message.tool_call_id === callId);
        const app = savedApp(messages);
        if (create) assert.ok((body.tools ?? []).some(tool => tool.function?.name === 'piora_render_mini_app'));
        requests.push({ prompt, create, callId, savedState: app ?? null }); assert.ok(requests.length < 24, 'Unexpected fixture loop');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `recovery-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant', ...(create ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'piora_render_mini_app', arguments: JSON.stringify(plans[kind]) } }] }
          : { content: `Recovery fixture observed: ${app?.summary ?? 'candidate awaiting confirmation'}` }) });
        emit({}, create ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
      } catch (error) { requests.push({ error: error.message }); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    registerCleanup(() => new Promise((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }));
    await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test-only',
      models: [{ id: model, name: 'Recovery Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const settingsPath = join(paths.agent, 'settings.json'), settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: model, enabledModels: [`${provider}/${model}`] }));
  },
  async run({ page, step, waitUntil, reload, screenshot, directory }) {
    const surface = title => page.locator('[data-mini-app-surface]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const old = surface('Recovery counter'), cancelled = surface('Cancelled revision'), candidate = surface('Progress revision');
    const frame = target => target.frameLocator('iframe[title="Interactive answer"]');
    const count = async (target, value) => frame(target).getByText(String(value), { exact: true }).waitFor();
    const saved = target => target.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).waitFor();
    const send = async kind => { await page.locator('textarea').first().fill(`Recovery fixture: ${kind}`); await page.getByRole('button', { name: /^(Send|发送)$/ }).click(); };
    const review = target => target.getByRole('button', { name: /^(Review changes \/ refresh|核对变化 \/ 刷新)$/ });
    const save = async target => { await target.getByRole('button', { name: /^(Save|保存)$/ }).click(); await saved(target); await waitUntil(() => target.getByRole('button', { name: /^(Save|保存)$/ }).isEnabled(), 'save settled'); };
    const read = async callId => {
      const id = new URL(page.url()).searchParams.get('session'); assert.ok(id);
      return page.evaluate(async path => { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw new Error(`Read checkpoint ${r.status}`); return r.json(); }, `/api/sessions/${id}/mini-app?toolCallId=${callId}`);
    };
    const records = [], writes = [], decisions = [], observationErrors = [], loaded = new Map();
    const record = async (label, callId) => { const output = await read(callId); records.push({ label, output }); await writeFile(join(directory, 'recovery-checkpoints.json'), JSON.stringify({ records, writes, decisions }, null, 2)); return output; };
    // Observe the response after Electron's real authenticated network request.
    // route.fetch() would create a separate request without Electron's auth
    // header. This fixture corrupts delivery only, never authorization/state.
    page.on('response', response => {
      const request = response.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && /\/api\/sessions\/[^/]+\/mini-app$/.test(path) && response.ok()) {
        void response.json().then(output => { if (output.toolCallId && output.leafId) loaded.set(output.toolCallId, output); }).catch(error => observationErrors.push(error.message));
      }
      const save = request.method() === 'PUT' && /\/api\/sessions\/[^/]+\/mini-app$/.test(path);
      const decision = request.method() === 'POST' && /\/api\/sessions\/[^/]+\/mini-app\/migration$/.test(path);
      if (!save && !decision) return;
      try {
        const body = request.postDataJSON();
        if (save) writes.push({ requestId: body.requestId, toolCallId: body.toolCallId, status: response.status() });
        else decisions.push({ choice: body, status: response.status() });
      } catch (error) { observationErrors.push(error.message); }
    });
    await step('install-response-fixture', () => page.evaluate(() => {
      const original = window.fetch; let drop = true;
      window.fetch = async (input, init) => {
        const request = new Request(input, init), response = await original.call(window, input, init);
        if (drop && request.method === 'PUT' && /\/api\/sessions\/[^/]+\/mini-app$/.test(new URL(request.url).pathname) && response.ok) {
          drop = false;
          // Drain the real response so the delivery fixture leaves no pending
          // network body; only the application's received JSON is corrupted.
          await response.arrayBuffer();
          return new Response('{"receipt":', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return response;
      };
    }));
    await step('enable-and-create', async () => {
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click(); const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/ });
      await dialog.getByRole('button', { name: /Beta Features/ }).click(); const toggle = dialog.getByRole('switch', { name: 'Intelligent UI' });
      await waitUntil(() => toggle.isEnabled(), 'Beta loaded'); if (!await toggle.isChecked()) await toggle.click();
      await waitUntil(async () => await toggle.isChecked() && await toggle.isEnabled(), 'Beta enabled');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      await send('create'); await count(old, 2); await saved(old);
    });
    let committed;
    await step('lost-save-response-retains-checkpoint', async () => {
      await frame(old).getByLabel('Starting value').fill('9'); await count(old, 9);
      await old.getByText(/^(Saving or loading did not finish\.|加载或保存未完成)/).waitFor();
      await waitUntil(() => writes.length === 1, 'real successful save observed');
      committed = await record('saved-with-lost-response', 'recovery-create'); assert.equal(committed.result.snapshot.state.count, 9); assert.equal(writes[0].status, 200);
      await screenshot('recovery-lost-response.png');
    });
    await step('reload-recovers-receipt-without-second-write', async () => {
      await reload(); await old.getByText(/^(Local checkpoints need review|有本机检查点需要核对)$/).waitFor();
      assert.equal(await old.locator('iframe').count(), 0);
      await old.getByRole('button', { name: /^(Recover this checkpoint|恢复这份检查点)$/ }).click(); await count(old, 9); await saved(old);
      const recovered = await record('receipt-recovered', 'recovery-create'); assert.deepEqual(recovered.result.snapshot, committed.result.snapshot);
      assert.equal(recovered.stateRevision, committed.stateRevision); assert.equal(writes.length, 1, 'Receipt recovery must not PUT again');
      await frame(old).getByRole('button', { name: 'Add one' }).click(); await count(old, 10); await save(old);
    });
    await step('cancel-candidate-preserves-progress', async () => {
      const before = await read('recovery-create'); await send('cancel'); await review(cancelled).click();
      await cancelled.getByRole('button', { name: /^(Cancel revision|取消这次变更)$/ }).click(); await cancelled.getByText(/^(This version was not published|此版本未发布)$/).waitFor();
      assert.deepEqual((await read('recovery-create')).result.snapshot, before.result.snapshot);
      await reload(); await count(old, 10); await cancelled.getByText(/^(This version was not published|此版本未发布)$/).waitFor();
      await frame(old).getByRole('button', { name: 'Add one' }).click(); await count(old, 11); await save(old);
      await record('cancelled-then-edited', 'recovery-create');
    });
    await step('source-edit-invalidates-an-open-review', async () => {
      const before = await read('recovery-create');
      await send('migrate'); await review(candidate).waitFor();
      await waitUntil(() => !!loaded.get('recovery-create')?.leafId && loaded.get('recovery-create').leafId !== before.leafId, 'existing source rebinds after the new conversation turn');
      await review(candidate).click(); await candidate.locator('input[type="number"]').waitFor();
      await frame(old).getByRole('button', { name: 'Add one' }).click(); await count(old, 12); await save(old);
      await candidate.getByRole('button', { name: /^(Confirm revision and restart progress|确认新版并重新开始进度)$/ }).click(); await candidate.getByRole('alert').waitFor();
      assert.equal((await read('recovery-migrate')).publication.status, 'awaiting_confirmation'); assert.equal((await read('recovery-create')).result.snapshot.state.count, 12);
      await waitUntil(() => decisions.length === 2, 'rejected confirmation response observed');
      assert.equal(decisions.at(-1).status, 409); await screenshot('recovery-stale-review.png');
    });
    let migrated;
    await step('refresh-review-and-migrate-current-progress', async () => {
      await review(candidate).click(); const choice = candidate.locator('input[type="number"]'); await choice.waitFor(); assert.equal(await choice.inputValue(), '9');
      await choice.fill('12'); await candidate.getByRole('combobox', { name: /^(Task progress|任务进度)$/ }).selectOption('migrate');
      await candidate.getByRole('button', { name: /^(Confirm revision and migrate progress|确认新版并迁移进度)$/ }).click(); await count(candidate, 15);
      migrated = await record('confirmed-migration', 'recovery-migrate'); const source = await read('recovery-create');
      assert.equal(migrated.result.snapshot.inputs.start, 12); assert.equal(migrated.result.snapshot.state.count, 15);
      assert.equal(migrated.result.snapshot.tick, source.result.snapshot.tick); assert.equal(migrated.result.snapshot.rng, source.result.snapshot.rng);
      assert.equal(source.writable, false); assert.equal(source.result.snapshot.state.count, 12);
      await waitUntil(() => decisions.length === 3, 'final confirmation response observed');
      assert.deepEqual(decisions.map(item => item.status), [200, 409, 200]);
      await screenshot('recovery-migrated.png');
    });
    let followed;
    await step('reload-edit-and-follow-up', async () => {
      await reload(); await count(candidate, 15); assert.deepEqual((await read('recovery-migrate')).result.snapshot, migrated.result.snapshot);
      await frame(candidate).getByRole('button', { name: 'Add one' }).click(); await count(candidate, 16); await save(candidate);
      const before = await record('edited-after-reload', 'recovery-migrate'); await send('follow-up');
      await page.getByText('Recovery fixture observed: Count: 16', { exact: true }).waitFor();
      await waitUntil(() => !!loaded.get('recovery-migrate')?.leafId && loaded.get('recovery-migrate').leafId !== before.leafId, 'ordinary follow-up rebinds the clean interactive output');
      assert.ok(this.report.fixture.requests.some(request => request.prompt === 'Recovery fixture: follow-up' && request.savedState?.summary === 'Count: 16'));
      const after = await record('after-follow-up', 'recovery-migrate'); assert.deepEqual(after.result.snapshot, before.result.snapshot); assert.equal(after.stateRevision, before.stateRevision);
      followed = after;
      assert.deepEqual(this.report.fixture.requests.filter(request => request.create).map(request => request.callId), ['recovery-create', 'recovery-cancel', 'recovery-migrate']);
      assert.deepEqual(observationErrors, []);
      await screenshot('recovery-follow-up.png');
    });
    await step('continue-editing-after-follow-up', async () => {
      await frame(candidate).getByRole('button', { name: 'Add one' }).click(); await count(candidate, 17); await save(candidate);
      const continued = await record('edited-after-follow-up', 'recovery-migrate');
      assert.equal(continued.result.snapshot.state.count, 17); assert.equal(continued.stateRevision, followed.stateRevision + 1);
      assert.equal(continued.result.snapshot.inputs.start, 12); assert.deepEqual(observationErrors, []);
      await screenshot('recovery-continued.png');
    });
  },
};
