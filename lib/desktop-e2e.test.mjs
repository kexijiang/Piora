import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRunLock, isolatedEnvironment, portOpen, reservePort, startProcess, stopProcess, waitUntil } from '../scripts/desktop-e2e/lifecycle.mjs';
import { runDesktopScenario, waitForDesktopWindow } from '../scripts/desktop-e2e/harness.mjs';
import { parseOptions } from '../scripts/run-desktop-e2e.mjs';
import { stopShell, stopBash } from '../scripts/desktop-e2e/scenarios/stop-shell.mjs';

for (const scenario of [stopShell, stopBash]) {
  test(`${scenario.id} fixture preserves isolation and generates a real shell call`, { skip: process.platform !== 'win32' }, async t => {
    const directory = await temporary(t), agent = join(directory, 'agent'), cleanup = [], report = {};
    await mkdir(agent);
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, packages: [] }));
    try {
      await scenario.prepare({ paths: { agent }, directory, report, registerCleanup: fn => cleanup.push(fn) });
      const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.retry, { enabled: false });
      const config = JSON.parse(await readFile(join(agent, 'models.json'), 'utf8'));
      const provider = config.providers[settings.defaultProvider];
      assert.equal(new URL(provider.baseUrl).hostname, '127.0.0.1');
      assert.equal(provider.apiKey, 'local-test-only');
      const tool = scenario === stopBash ? 'bash' : 'powershell';
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], tools: [{ function: { name: tool } }] }),
      });
      assert.equal(response.status, 200);
      const chunk = (await response.text()).split('\n')[0].slice('data: '.length);
      const call = JSON.parse(chunk).choices[0].delta.tool_calls[0].function;
      assert.equal(call.name, tool);
      const args = JSON.parse(call.arguments);
      assert.equal(args.timeout, 45);
      assert.match(args.command, tool === 'bash' ? /cat \/proc\/\$\$\/winpid/ : /\[string\]\$PID/);
      assert.match(args.command, tool === 'bash' ? /sleep 30/ : /Start-Sleep -Seconds 30/);
      assert.equal(parseOptions(['--scenario', scenario.id]).scenario, scenario.id);
    } finally {
      for (const close of cleanup.reverse()) await close();
    }
  });
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'piora-desktop-e2e-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return root;
}
function scenario(run) { return { id: 'fixture', scope: 'lifecycle fixture, not Electron evidence', coverage: ['runner'], limits: ['real UI'], run }; }
function adapter(events, pageErrors = []) {
  return async ({ registerCleanup }) => {
    registerCleanup(async () => events.push('process-stop'));
    registerCleanup(async () => events.push('cdp-close'));
    return { pageErrors, screenshot: async name => events.push(name) };
  };
}

test('startup reconnects after Electron restarts before the application mounts', async () => {
  const cleanup = [], connections = [];
  const page = { isClosed: () => false, url: () => 'http://127.0.0.1:30141/', locator: () => ({ isVisible: async () => true }) };
  const makeBrowser = ready => {
    const browser = { connected: true, isConnected: () => browser.connected,
      close: async () => { browser.connected = false; },
      contexts: () => [{ pages: () => [ready ? page : { ...page, locator: () => ({ isVisible: async () => { browser.connected = false; return false; } }) }] }],
    }; return browser;
  };
  const result = await waitForDesktopWindow({ origin: 'http://127.0.0.1:30141', timeoutMs: 2000,
    connect: async () => { const browser = makeBrowser(connections.length > 0); connections.push(browser); return browser; },
    checkAlive: () => {}, registerCleanup: fn => cleanup.push(fn),
  });
  assert.equal(result, page); assert.equal(connections.length, 2);
  for (const close of cleanup.reverse()) await close();
  assert.ok(connections.every(browser => !browser.isConnected()));
});

test('startup fails when the launcher exits and never invents a mounted page', async () => {
  await assert.rejects(waitForDesktopWindow({ origin: 'http://127.0.0.1:30141', timeoutMs: 500,
    connect: async () => { throw new Error('Must not connect to an exited launcher'); },
    checkAlive: () => { throw new Error('Desktop exited'); }, registerCleanup: () => {},
  }), /Desktop exited/);
});

test('environment isolates all Pi paths and drops credentials, injection and unrelated overrides', () => {
  const env = isolatedEnvironment({ PATH: 'path', SystemRoot: 'windows', HOME: 'home', OPENAI_API_KEY: 'private',
    DEEPSEEK_API_KEY: 'private', NODE_OPTIONS: '--require private.js', ELECTRON_RUN_AS_NODE: '1',
    PI_CODING_AGENT_DIR: 'production', PIORA_DESKTOP_DEV_USER_DATA: 'shared', PIORA_UI_INPUT_PROTOCOL: 'old', PIORA_DESKTOP_DEV_COMPILE_ONCE: '0' },
  { profile: 'isolated-profile', agent: 'isolated-agent', dist: 'next', tsconfig: 'config', port: 30142, debugPort: 9323 });
  assert.equal(env.PATH, 'path'); assert.equal(env.SystemRoot, 'windows'); assert.equal(env.HOME, 'home');
  assert.equal(env.PI_CODING_AGENT_DIR, 'isolated-agent'); assert.equal(env.PIORA_DESKTOP_DEV_USER_DATA, 'isolated-profile');
  assert.equal(env.PIORA_DESKTOP_DEV_COMPILE_ONCE, '1', 'automation freezes its desktop fixture even if the caller requested watching');
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PIORA_UI_INPUT_PROTOCOL']) assert.equal(env[key], undefined);
});

test('same-checkout lock refuses concurrency and can be acquired after release', async t => {
  const root = await temporary(t), path = join(root, 'lock');
  const release = await acquireRunLock(path);
  await assert.rejects(acquireRunLock(path), /Another desktop test/);
  await release(); await (await acquireRunLock(path))();
});

test('cleanup never removes a lock whose owner changed', async t => {
  const root = await temporary(t), path = join(root, 'lock'), release = await acquireRunLock(path);
  await writeFile(join(path, 'owner.json'), JSON.stringify({ token: 'different-owner' }));
  await assert.rejects(release(), /ownership changed/);
  assert.equal(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')).token, 'different-owner');
});

test('port allocation refuses a busy endpoint without stopping its owner', async () => {
  const first = await reservePort();
  try {
    await assert.rejects(reservePort(first.port), { code: 'EADDRINUSE' });
    assert.equal(await portOpen(first.port), true);
  } finally { await first.release(); }
  assert.equal(await portOpen(first.port), false);
});

test('waitUntil bounds a never-resolving predicate and preserves external cancellation', async () => {
  await assert.rejects(waitUntil(() => new Promise(() => {}), { timeoutMs: 25, label: 'hung predicate' }), /Timed out waiting for hung predicate/);
  const controller = new AbortController();
  const pending = waitUntil(() => false, { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(new Error('user stopped'));
  await assert.rejects(pending, /user stopped/);
});

test('a real child process is stopped and ENOENT is observed without unhandled errors', async t => {
  const child = startProcess(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopProcess(child));
  let ready = false; child.child.stdout.on('data', () => { ready = true; });
  await waitUntil(() => ready, { timeoutMs: 5000 });
  await stopProcess(child); assert.ok(child.outcome());
  const absent = startProcess('piora-nonexistent-executable-for-test', [], { stdio: 'ignore' });
  assert.match((await absent.exited).error, /ENOENT/); await stopProcess(absent);
});

test('successful scenario writes evidence and cleans resources in reverse order', async t => {
  const root = await temporary(t), events = [];
  const result = await runDesktopScenario({ root, launch: adapter(events), scenario: scenario(async ({ step }) => {
    await step('assert-state', async () => assert.equal(2 + 2, 4));
  }) });
  assert.equal(result.report.status, 'passed'); assert.deepEqual(events, ['cdp-close', 'process-stop']);
  const stored = JSON.parse(await readFile(join(result.directory, 'result.json'), 'utf8'));
  assert.equal(stored.steps[1].name, 'assert-state'); assert.equal(stored.steps[1].status, 'passed');
  assert.match(await readFile(join(result.directory, 'report.md'), 'utf8'), /not Electron evidence/);
  assert.ok(!(await readdir(join(root, '.verification'))).includes('desktop-e2e.lock'));
});

test('assertion failures retain the failing step and screenshot, without skipping cleanup', async t => {
  const root = await temporary(t), events = [];
  const result = await runDesktopScenario({ root, launch: adapter(events), scenario: scenario(async ({ step }) => {
    await step('business-result', async () => assert.equal('actual', 'expected'));
  }) });
  assert.equal(result.report.status, 'failed'); assert.equal(result.report.failedStep, 'business-result');
  assert.equal(result.report.error.name, 'AssertionError');
  assert.deepEqual(events, ['failure.png', 'cdp-close', 'process-stop']);
});

test('startup failure releases acquired resources and emits a failure report', async t => {
  const root = await temporary(t), events = [];
  const result = await runDesktopScenario({ root, scenario: scenario(() => assert.fail('must not run')), launch: async ({ registerCleanup }) => {
    registerCleanup(async () => events.push('stopped')); throw new Error('startup failed');
  } });
  assert.equal(result.report.status, 'failed'); assert.equal(result.report.failedStep, 'launch'); assert.deepEqual(events, ['stopped']);
  await (await acquireRunLock(join(root, '.verification', 'desktop-e2e.lock')))();
});

test('timeout and user interruption cannot be reported as success', async t => {
  for (const kind of ['timeout', 'interrupt']) {
    const root = await temporary(t), events = [], controller = new AbortController();
    const result = await runDesktopScenario({ root, launch: adapter(events), timeoutMs: 200, signal: controller.signal,
      scenario: scenario(async ({ step }) => step('waiting', async () => {
        if (kind === 'interrupt') controller.abort(new Error('user interrupt'));
        return new Promise(() => {});
      })) });
    assert.equal(result.report.status, kind === 'timeout' ? 'failed' : 'cancelled');
    assert.deepEqual(events, ['failure.png', 'cdp-close', 'process-stop']);
  }
});

test('cancellation during acquisition waits for late resources to be registered and closed', async t => {
  const root = await temporary(t), controller = new AbortController(), events = [];
  const result = await runDesktopScenario({ root, signal: controller.signal, scenario: scenario(() => assert.fail('must not run')),
    launch: async ({ signal, registerCleanup }) => {
      controller.abort(new Error('interrupted while connecting'));
      await delay(20);
      registerCleanup(async () => events.push('late-connection-closed'));
      signal.throwIfAborted();
    } });
  assert.equal(result.report.status, 'cancelled'); assert.deepEqual(events, ['late-connection-closed']);
});

test('cleanup or renderer errors fail the run even after successful steps', async t => {
  for (const kind of ['cleanup', 'renderer']) {
    const root = await temporary(t);
    const result = await runDesktopScenario({ root, scenario: scenario(async () => {}), launch: async ({ registerCleanup }) => {
      registerCleanup(async () => { if (kind === 'cleanup') throw new Error('could not stop'); });
      return { pageErrors: kind === 'renderer' ? ['render failed'] : [], screenshot: async () => {} };
    } });
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.cleanupErrors.length, kind === 'cleanup' ? 1 : 0);
    assert.equal(result.report.pageErrors.length, kind === 'renderer' ? 1 : 0);
    const hasLock = (await readdir(join(root, '.verification'))).includes('desktop-e2e.lock');
    assert.equal(hasLock, kind === 'cleanup');
    if (kind === 'cleanup') {
      assert.equal(result.report.lockRetained, true);
      await assert.rejects(acquireRunLock(join(root, '.verification', 'desktop-e2e.lock')), /Another desktop test/);
    }
  }
});

test('intentional failure injection preserves failure and rejects an unvisited step', async t => {
  for (const failAt of ['checkpoint', 'missing']) {
    const root = await temporary(t), events = [];
    const result = await runDesktopScenario({ root, failAt, launch: adapter(events), scenario: scenario(async ({ step }) => step('checkpoint', async () => {})) });
    assert.equal(result.report.status, 'failed');
    assert.match(result.report.error.message, failAt === 'missing' ? /not reached/ : /Intentional failure/);
  }
});

test('a hung cleanup is bounded and later cleanup still runs', async t => {
  const root = await temporary(t), events = [];
  const result = await runDesktopScenario({ root, scenario: scenario(async () => {}), cleanupTimeoutMs: 25,
    launch: async ({ registerCleanup }) => {
      registerCleanup(async () => events.push('process-stopped'));
      registerCleanup(() => new Promise(() => {}));
      return { pageErrors: [], screenshot: async () => {} };
    } });
  assert.equal(result.report.status, 'failed'); assert.deepEqual(events, ['process-stopped']);
  assert.deepEqual(result.report.cleanupErrors, ['Resource cleanup timed out']);
  assert.equal(result.report.lockRetained, true);
});

test('CLI rejects unknown scenarios, invalid budgets and conflicting ports', () => {
  assert.equal(parseOptions([]).scenario, 'settings-theme'); assert.equal(parseOptions(['--list']).list, true);
  assert.equal(parseOptions(['--scenario', 'intelligent-ui-mini-app']).scenario, 'intelligent-ui-mini-app');
  for (const args of [['--scenario', 'unknown'], ['--model', 'secret'], ['--timeout-ms', '-1'], ['--port', '0'],
    ['--debug-port', '65536'], ['--timeout-ms'], ['--port', '9322', '--debug-port', '9322']]) assert.throws(() => parseOptions(args));
});
