import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareWorkflowModel } from '../workflow-model-fixture.mjs';

let fixture;
const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export const planGoal = {
  id: 'plan-goal',
  mode: 'local-model-fixture',
  scope: 'real Electron UI, Next routes, SDK and workflow tools with a deterministic loopback model; API reads only verify results',
  coverage: ['laboratory defaults off and is enabled through Settings UI', 'new-chat Plan selection', 'runtime denial of an attempted Plan write', 'immutable plan revision and confirmation', 'real SDK write after UI approval', 'Goal continuation and turn budget', 'pause, refresh, resume and cancel', 'process restart without automatic replay', 'persisted history and model-reported evidence', 'disabled laboratory preserves history and stop controls but blocks new modes and continuation', 'disabling laboratory stops automatic continuation at the current turn boundary'],
  limits: ['real model reasoning or evidence truthfulness', 'arbitrary external MCP tools', 'packaged installer', 'non-Windows platforms', 'real task semantic acceptance'],
  async prepare(context) { fixture = await prepareWorkflowModel(context); },
  async run(context) {
    let { page } = context;
    const { step, waitUntil, screenshot, reload, restart, directory } = context;
    const observations = [], mutations = [], laboratory = [];
    let sessionId;
    const observe = target => target.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (!((request.method() === 'POST' && path.startsWith('/api/agent/')) || (request.method() === 'PUT' && path === '/api/settings/laboratory'))) return;
      const body = request.postDataJSON();
      mutations.push({ path, body, at: Date.now() });
      if (body?.type === 'submit_input' || body?.type === 'prompt') sessionId = path.split('/').at(-1);
    });
    observe(page);
    const panel = () => page.getByTestId('workflow-panel');
    const readLaboratory = async () => {
      const result = await page.evaluate(async () => {
        const response = await fetch('/api/settings/laboratory');
        return { status: response.status, body: await response.json() };
      });
      assert.equal(result.status, 200);
      assert.equal(typeof result.body.planGoalEnabled, 'boolean');
      laboratory.push({ at: Date.now(), state: result.body });
      return result.body;
    };
    const setLaboratory = async (enabled, imageName) => {
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
      const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/ });
      await dialog.getByTestId('settings-laboratory').click();
      const toggle = dialog.getByTestId('laboratory-plan-goal-toggle');
      await toggle.waitFor();
      if (await toggle.isChecked() !== enabled) await toggle.click();
      await waitUntil(async () => (await readLaboratory()).planGoalEnabled === enabled, `laboratory setting ${enabled}`);
      assert.equal(await toggle.isChecked(), enabled);
      await waitUntil(() => toggle.isEnabled(), 'laboratory setting save to settle');
      if (imageName) await screenshot(imageName);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await waitUntil(async () => enabled ? await page.getByTestId('workflow-mode-select').count() === 1 : await page.getByTestId('workflow-mode-select').count() === 0, 'composer laboratory visibility');
    };
    const snapshot = async () => {
      assert.ok(sessionId, 'UI send must establish a real session');
      const response = await page.evaluate(async id => {
        const res = await fetch(`/api/agent/${encodeURIComponent(id)}/workflow`);
        return { status: res.status, body: await res.json() };
      }, sessionId);
      assert.equal(response.status, 200);
      const state = response.body.snapshot ?? response.body;
      observations.push({ at: Date.now(), state });
      return state;
    };
    const stateIs = async expected => {
      await waitUntil(() => sessionId, 'UI submission to identify its new session');
      await waitUntil(async () => (await snapshot()).current?.status === expected, `workflow status ${expected}`);
      await waitUntil(async () => await panel().getAttribute('data-status') === expected, `rendered workflow status ${expected}`);
      return snapshot();
    };
    const send = async message => {
      await page.locator('textarea').first().fill(message);
      await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
    };
    const idle = async () => waitUntil(async () => {
      const result = await page.evaluate(async id => (await fetch(`/api/agent/${encodeURIComponent(id)}`)).json(), sessionId);
      return !result.running || result.state?.runtime === 'idle';
    }, 'SDK run to settle');
    try {
      await step('laboratory-default-off-and-enable', async () => {
        assert.equal((await readLaboratory()).planGoalEnabled, false, 'Fresh profiles must not opt into Plan / Goal');
        assert.equal(await page.getByTestId('workflow-mode-select').count(), 0);
        await setLaboratory(true, 'laboratory-enabled.png');
        assert.equal(fixture.requests.filter(request => request.workflow).length, 0, 'Enabling the laboratory does not start a model');
      });
      await step('plan-new-chat-read-only', async () => {
        await page.getByTestId('workflow-mode-select').selectOption('plan');
        await send('PLAN_GOAL_E2E_PLAN: Plan the fixture write, wait for my approval before changing files.');
        const state = await stateIs('awaiting_approval');
        assert.equal(state.mode, 'plan');
        assert.equal(state.current.title, 'Fixture plan v1');
        assert.equal(await read(fixture.forbiddenPath), null, 'Attempted planning write must never execute');
        assert.equal(await read(fixture.approvedPath), null);
        assert.equal(fixture.calls.filter(call => call.name === 'write').length, 1, 'Fixture must actually attempt the denied write');
        await idle();
        await waitUntil(() => page.getByTestId('workflow-plan-approve').isEnabled(), 'plan confirmation control to become ready');
        await screenshot('plan-awaiting-approval.png');
      });
      let firstPlan;
      await step('plan-refresh-and-revise', async () => {
        firstPlan = (await snapshot()).current;
        await reload();
        const restored = await stateIs('awaiting_approval');
        assert.equal(restored.current.id, firstPlan.id);
        assert.equal(restored.current.markdown, firstPlan.markdown);
        await page.getByTestId('workflow-plan-revise').click();
        await stateIs('planning');
        fixture.stage = 'plan-revised';
        await send('PLAN_GOAL_E2E_REVISE: Include the exact APPROVED_BY_UI output in the plan.');
        const revised = await stateIs('awaiting_approval');
        assert.equal(revised.current.title, 'Fixture plan v2');
        assert.equal(revised.current.id, firstPlan.id);
        assert.equal(revised.current.version, firstPlan.version + 1);
        assert.ok(revised.history.some(run => run.id === firstPlan.id && run.markdown === firstPlan.markdown), 'Original plan is retained unchanged');
        assert.equal(await read(fixture.approvedPath), null);
        await idle();
      });
      await step('plan-approve-and-execute-once', async () => {
        fixture.stage = 'plan-approved';
        await page.getByTestId('workflow-plan-approve').click();
        await waitUntil(async () => await read(fixture.approvedPath) === 'APPROVED_BY_UI', 'real approved write');
        await stateIs('completed');
        await idle();
        assert.equal(fixture.calls.filter(call => call.stage === 'plan-approved' && call.name === 'write').length, 1);
        assert.equal(await read(fixture.forbiddenPath), null);
        await screenshot('plan-executed.png');
      });
      await step('goal-existing-chat-budget', async () => {
        fixture.stage = 'goal-budget';
        await page.getByTestId('workflow-mode-select').selectOption('goal');
        await page.getByTestId('workflow-budget-input').fill('2');
        await send('PLAN_GOAL_E2E_BUDGET: Work until the controlled checkpoint, using a budget of two turns.');
        const state = await stateIs('budget_exhausted');
        await idle();
        assert.equal(state.current.turnsUsed, 2);
        assert.equal(state.current.turnBudget, 2);
        assert.equal(state.current.criteria[0].status, 'pending');
        assert.equal(fixture.calls.filter(call => call.stage === 'goal-budget' && call.name === 'piora_update_goal').length, 2);
        await reload();
        assert.equal((await stateIs('budget_exhausted')).current.id, state.current.id);
        await screenshot('goal-budget-exhausted.png');
      });
      await step('goal-budget-edit-does-not-resume', async () => {
        const before = fixture.requests.filter(request => request.workflow).length;
        await page.getByTestId('workflow-run-budget-input').fill('4');
        await page.getByTestId('workflow-goal-set-budget').click();
        await waitUntil(async () => (await snapshot()).current?.turnBudget === 4, 'updated budget');
        assert.equal((await snapshot()).current.status, 'budget_exhausted');
        assert.equal(fixture.requests.filter(request => request.workflow).length, before, 'Saving budget cannot start a workflow model request');
        fixture.stage = 'budget-complete';
        await page.getByTestId('workflow-goal-resume').click();
        const completed = await stateIs('completed');
        await idle();
        assert.equal(completed.current.criteria[0].status, 'verified');
        assert.match(completed.current.criteria[0].evidence, /synthetic model-reported evidence/);
      });
      await step('goal-pause-refresh-resume', async () => {
        fixture.stage = 'pause-hold';
        await send('PLAN_GOAL_E2E_PAUSE: Wait for my pause and resume before reaching the controlled checkpoint.');
        await waitUntil(() => fixture.holds.some(hold => hold.stage === 'pause-hold'), 'live held provider request');
        await stateIs('running');
        await page.getByTestId('workflow-goal-pause').click();
        const paused = await stateIs('paused');
        await idle();
        await waitUntil(() => fixture.holds.find(hold => hold.stage === 'pause-hold')?.closed, 'paused request to close');
        await reload();
        assert.equal((await stateIs('paused')).current.id, paused.current.id);
        fixture.stage = 'pause-complete';
        await page.getByTestId('workflow-goal-resume').click();
        assert.equal((await stateIs('completed')).current.id, paused.current.id);
        await idle();
        await screenshot('goal-resumed-completed.png');
      });
      await step('goal-cancel', async () => {
        fixture.stage = 'cancel-hold';
        await send('PLAN_GOAL_E2E_CANCEL: Keep this controlled goal open until I cancel.');
        await waitUntil(() => fixture.holds.some(hold => hold.stage === 'cancel-hold'), 'live cancellable request');
        await page.getByTestId('workflow-goal-cancel').click();
        await stateIs('cancelled');
        await idle();
        await waitUntil(() => fixture.holds.find(hold => hold.stage === 'cancel-hold')?.closed, 'cancelled request to close');
        await reload();
        await stateIs('cancelled');
      });
      await step('goal-process-restart-does-not-replay', async () => {
        fixture.stage = 'restart-hold';
        await page.getByTestId('workflow-mode-select').selectOption('goal');
        await send('PLAN_GOAL_E2E_RESTART: Keep the controlled goal open until an explicit resume after restart.');
        await waitUntil(() => fixture.holds.some(hold => hold.stage === 'restart-hold'), 'live pre-restart request');
        const running = await stateIs('running');
        const before = fixture.requests.filter(request => request.workflow).length;
        page = await restart(); observe(page);
        // Startup opens a new-task surface; reopening persisted history is a UI action.
        await page.locator(`[data-session-drag-id="${sessionId}"]`).click();
        const restored = await stateIs('paused');
        assert.equal(restored.current.id, running.current.id);
        await idle();
        assert.equal(fixture.requests.filter(request => request.workflow).length, before, 'Restart must not replay the model request');
        fixture.stage = 'restart-complete';
        await page.getByTestId('workflow-goal-resume').click();
        await stateIs('completed');
        await idle();
        assert.equal(fixture.failures.length, 0, 'Fixture requests must stay within the controlled contract');
        await screenshot('goal-restart-resumed.png');
      });
      await step('laboratory-disable-preserves-history-and-stop', async () => {
        fixture.stage = 'laboratory-pause-hold';
        await page.getByTestId('workflow-mode-select').selectOption('goal');
        await send('PLAN_GOAL_E2E_LABORATORY_PAUSE: Preserve this goal when I disable the laboratory and pause.');
        await waitUntil(() => fixture.holds.some(hold => hold.stage === 'laboratory-pause-hold'), 'laboratory goal provider request');
        const running = await stateIs('running');
        const before = fixture.requests.filter(request => request.workflow).length;
        await setLaboratory(false);
        assert.equal(await page.getByTestId('workflow-goal-pause').isEnabled(), true, 'Disabling cannot remove the stop control');
        assert.equal(await page.getByTestId('workflow-goal-cancel').isEnabled(), true);
        await page.getByTestId('workflow-goal-pause').click();
        const paused = await stateIs('paused');
        await idle();
        await waitUntil(() => fixture.holds.find(hold => hold.stage === 'laboratory-pause-hold')?.closed, 'disabled goal request to close on pause');
        assert.equal(paused.current.id, running.current.id);
        assert.deepEqual(paused.history, running.history);
        assert.equal(await page.getByTestId('workflow-goal-resume').isDisabled(), true);
        assert.equal(await page.getByTestId('workflow-goal-set-budget').isDisabled(), true);
        await page.getByTestId('workflow-history').locator('summary').first().click();
        assert.equal(await page.getByTestId('workflow-history-entry').count(), paused.history.length);
        await screenshot('laboratory-disabled-goal.png');
        await page.getByRole('button', { name: /^(New chat|新对话)$/ }).click();
        assert.equal(await page.getByTestId('workflow-mode-select').count(), 0, 'Disabled new chat cannot select a workflow');
        await page.locator(`[data-session-drag-id="${sessionId}"]`).click();
        assert.equal((await stateIs('paused')).current.id, paused.current.id);
        await reload();
        assert.equal((await readLaboratory()).planGoalEnabled, false);
        assert.equal((await stateIs('paused')).current.id, paused.current.id);
        assert.equal(await page.getByTestId('workflow-goal-resume').isDisabled(), true);
        await setLaboratory(true);
        assert.equal(fixture.requests.filter(request => request.workflow).length, before, 'Re-enabling cannot resume a stopped goal');
        fixture.stage = 'laboratory-resume-complete';
        await page.getByTestId('workflow-goal-resume').click();
        assert.equal((await stateIs('completed')).current.id, paused.current.id);
        await idle();
      });
      await step('laboratory-disable-stops-next-turn', async () => {
        fixture.stage = 'laboratory-finish-hold';
        await page.getByTestId('workflow-mode-select').selectOption('goal');
        await send('PLAN_GOAL_E2E_LABORATORY_BOUNDARY: Stop automatic continuation when the current turn finishes after I disable the laboratory.');
        await waitUntil(() => fixture.holds.some(hold => hold.stage === 'laboratory-finish-hold'), 'current goal turn to wait for its provider');
        const running = await stateIs('running');
        await setLaboratory(false);
        const before = fixture.requests.filter(request => request.workflow).length;
        fixture.releaseHold('laboratory-finish-hold');
        const paused = await stateIs('paused');
        await idle();
        assert.equal(paused.current.id, running.current.id);
        assert.equal(paused.current.reason, 'laboratory_disabled');
        assert.equal(paused.current.turnsUsed, 1);
        assert.equal(await page.getByTestId('workflow-goal-resume').isDisabled(), true);
        assert.equal(fixture.requests.filter(request => request.workflow).length, before, 'Disabled laboratory cannot queue another model turn');
        await setLaboratory(true);
        assert.equal(fixture.requests.filter(request => request.workflow).length, before, 'Re-enabling only restores controls');
        fixture.stage = 'laboratory-finish-complete';
        await page.getByTestId('workflow-goal-resume').click();
        assert.equal((await stateIs('completed')).current.id, paused.current.id);
        await idle();
        assert.equal(fixture.failures.length, 0);
        await screenshot('goal-laboratory-resumed.png');
      });
    } finally {
      await writeFile(join(directory, 'workflow-evidence.json'), JSON.stringify({ observations, mutations, laboratory, requests: fixture.requests, calls: fixture.calls, holds: fixture.holds, failures: fixture.failures }, null, 2));
    }
  },
};
