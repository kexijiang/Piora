import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Only the model is scripted. The desktop, SDK, tools, stores and UI are real. */
export async function prepareWorkflowModel({ paths, directory, registerCleanup, report }) {
  const fixture = {
    stage: 'plan', requests: [], calls: [], holds: [], failures: [],
    forbiddenPath: join(directory, 'plan-forbidden.txt'), approvedPath: join(directory, 'plan-approved.txt'),
  };
  const stageCounts = new Map();
  const heldResponses = new Map();
  const respond = (res, call, content) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'workflow-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'plan-goal', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', ...(call ? { tool_calls: [{ index: 0, id: `workflow-call-${fixture.calls.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content }) });
    emit({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  };
  fixture.releaseHold = stage => {
    const release = heldResponses.get(stage);
    assert.ok(release, `Expected a live provider response for ${stage}`);
    release();
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tools = (body.tools ?? []).map(tool => tool.function?.name);
      const workflow = tools.includes('piora_submit_plan') || tools.includes('piora_update_goal');
      const row = { at: Date.now(), stage: fixture.stage, tools, path: req.url, workflow };
      fixture.requests.push(row);
      assert.ok(fixture.requests.length < 80, 'Unexpected fixture model request loop');
      let call, content = 'Plan / Goal fixture';
      if (workflow) {
        const count = stageCounts.get(fixture.stage) ?? 0;
        stageCounts.set(fixture.stage, count + 1);
        if (fixture.stage.endsWith('-hold')) {
          const hold = { stage: fixture.stage, at: Date.now(), closed: false };
          fixture.holds.push(hold);
          // UI pause/cancel and process restart must close these real SDK requests.
          // One laboratory case explicitly releases a response to verify the turn boundary.
          const watchdog = setTimeout(() => {
            fixture.failures.push(`Uncancelled held request: ${hold.stage}`);
            res.writeHead(504); res.end('Held fixture request was not cancelled');
          }, 180_000);
          heldResponses.set(fixture.stage, () => { hold.released = true; respond(res, undefined, 'GOAL_FIXTURE_RELEASED'); });
          res.once('close', () => { hold.closed = true; hold.closedAt = Date.now(); clearTimeout(watchdog); heldResponses.delete(hold.stage); });
          return;
        }
        if (fixture.stage === 'plan') {
          if (count === 0) call = { name: 'write', arguments: { path: fixture.forbiddenPath, content: 'MUST_NOT_BE_WRITTEN' } };
          else if (count === 1) call = { name: 'piora_submit_plan', arguments: { title: 'Fixture plan v1', markdown: '# Objective\nWrite the approved fixture file.\n\n# Steps\n1. Wait for approval.\n2. Write the fixture file.\n\n# Validation\nRead back the exact file contents.' } };
          else content = 'PLAN_FIXTURE_READY';
        } else if (fixture.stage === 'plan-revised') {
          if (count === 0) call = { name: 'piora_submit_plan', arguments: { title: 'Fixture plan v2', markdown: '# Objective\nWrite the approved fixture file.\n\n# Steps\n1. Wait for approval.\n2. Write APPROVED_BY_UI to the fixture file.\n\n# Validation\nRead back APPROVED_BY_UI exactly.' } };
          else content = 'PLAN_FIXTURE_REVISED';
        } else if (fixture.stage === 'plan-approved') {
          if (count === 0) call = { name: 'write', arguments: { path: fixture.approvedPath, content: 'APPROVED_BY_UI' } };
          else content = 'PLAN_FIXTURE_EXECUTED';
        } else if (fixture.stage === 'goal-budget') {
          if (count % 2 === 0) call = { name: 'piora_update_goal', arguments: {
            progress: `Recorded bounded goal turn ${Math.floor(count / 2) + 1}`,
            criteria: [{ id: 'fixture', text: 'Record a verified completion from the controlled fixture', status: 'pending', evidence: '' }],
          } };
          else content = 'GOAL_FIXTURE_PROGRESS';
        } else if (fixture.stage.endsWith('-complete')) {
          if (count === 0) call = { name: 'piora_update_goal', arguments: {
            progress: 'Controlled fixture reached its completion checkpoint', status: 'completed',
            criteria: [{ id: 'fixture', text: 'Record a verified completion from the controlled fixture', status: 'verified', evidence: 'The deterministic local model emitted this checkpoint after the UI resumed the run. This is synthetic model-reported evidence, not real task validation.' }],
          } };
          else content = 'GOAL_FIXTURE_COMPLETED';
        } else throw new Error(`Unknown fixture stage: ${fixture.stage}`);
      }
      if (call) fixture.calls.push({ stage: fixture.stage, ...call, at: Date.now() });
      respond(res, call, content);
    } catch (error) {
      fixture.failures.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerCleanup(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const provider = 'desktop-workflow-fixture';
  await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test-only',
    models: [{ id: 'plan-goal', name: 'Plan / Goal Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const settingsPath = join(paths.agent, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, enabledModels: [`${provider}/plan-goal`] }));
  report.fixture = { provider, model: 'plan-goal', requests: fixture.requests, calls: fixture.calls, holds: fixture.holds, failures: fixture.failures, credentials: 'synthetic-local-only' };
  return fixture;
}
