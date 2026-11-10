import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { abortable, acquireRunLock, isolatedEnvironment, portOpen, reservePort, startProcess, stopProcess, waitUntil } from './lifecycle.mjs';

function gitIdentity(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5_000 }).trim();
  try { return { commit: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=normal']) }; }
  catch { return { unavailable: true }; }
}

/** Dev compilation can restart Electron before the application is mounted.
 * Reconnect only during startup; a restart during a scenario remains a failure. */
export async function waitForDesktopWindow({ connect, checkAlive, origin, registerCleanup, signal, timeoutMs = 600_000 }) {
  let browser;
  return waitUntil(async () => {
    checkAlive();
    if (!browser?.isConnected()) {
      try {
        browser = await connect();
        const connection = browser;
        registerCleanup(async () => { if (connection.isConnected()) await connection.close(); });
      } catch (error) { signal?.throwIfAborted(); if (browser?.isConnected()) throw error; return false; }
    }
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      if (page.isClosed() || !page.url().startsWith(origin + '/')) continue;
      try { if (await page.locator('.app-shell').isVisible()) return page; }
      catch (error) { if (browser.isConnected() && !page.isClosed()) throw error; }
    }
    return false;
  }, { signal, timeoutMs, label: 'mounted Piora application window' });
}

async function launchDesktop({ root, directory, signal, registerCleanup, report, stepTimeoutMs, port, debugPort, scenario }) {
  const appPort = await reservePort(port);
  let debugLease;
  try { debugLease = await reservePort(debugPort); }
  catch (error) { await appPort.release(); throw error; }
  let leased = true;
  registerCleanup(async () => { if (leased) { leased = false; await Promise.all([appPort.release(), debugLease.release()]); } });
  const paths = { profile: join(directory, 'profile'), agent: join(directory, 'agent'),
    dist: relative(root, join(directory, 'next')).replaceAll('\\', '/'),
    tsconfig: relative(root, join(directory, 'tsconfig.json')).replaceAll('\\', '/'), port: appPort.port, debugPort: debugLease.port };
  await mkdir(paths.agent);
  await writeFile(join(paths.agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false } }));
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json',
    compilerOptions: { tsBuildInfoFile: './web.tsbuildinfo' }, include: ['../../**/*.ts', '../../**/*.tsx'] }));
  const env = isolatedEnvironment(process.env, paths);
  const origin = `http://127.0.0.1:${appPort.port}`, debugging = `http://127.0.0.1:${debugLease.port}`;
  report.origin = origin;
  report.debugging = debugging;
  report.desktopCompilation = 'single development fixture compilation; desktop hot restart disabled for this scenario';
  report.credentials = 'not-copied-or-injected';
  if (scenario?.prepare) await scenario.prepare({ paths, directory, signal, registerCleanup, report });
  const log = createWriteStream(join(directory, 'desktop.log'), { flags: 'wx' });
  let logError;
  log.on('error', error => { logError = error; });
  registerCleanup(() => new Promise((resolve, reject) => {
    if (logError) return reject(logError);
    log.end(() => logError ? reject(logError) : resolve());
  }));
  const start = script => {
    signal.throwIfAborted();
    const handle = startProcess(process.execPath, [join(root, script)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    handle.child.stdout.pipe(log, { end: false }); handle.child.stderr.pipe(log, { end: false });
    registerCleanup(() => stopProcess(handle));
    return handle;
  };
  const preparation = start('scripts/prepare-development.mjs');
  const prepared = await abortable(() => preparation.exited, signal);
  if (prepared.code !== 0) throw new Error(`Development preparation failed: ${JSON.stringify(prepared)}; see desktop.log`);
  await Promise.all([appPort.release(), debugLease.release()]); leased = false;
  // This runs after stopProcess (reverse cleanup order), even when startup failed.
  const checkPorts = async () => {
    await waitUntil(async () => !await portOpen(appPort.port) && !await portOpen(debugLease.port), { timeoutMs: 10_000, label: 'test ports to close' });
  };
  // start() registers termination after this check, so reverse cleanup stops first.
  registerCleanup(checkPorts);
  let desktop = start('scripts/dev-desktop.mjs');
  report.launchPid = desktop.child.pid;
  const checkAlive = () => {
    signal.throwIfAborted();
    if (desktop.outcome()) throw new Error(`Desktop exited: ${JSON.stringify(desktop.outcome())}; see desktop.log`);
    if (logError) throw logError;
  };
  let browser, page, ready;
  const pageErrors = [];
  const connectOnce = async () => {
    await waitUntil(async () => {
      checkAlive();
      try { return (await fetch(`${debugging}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) })).ok; }
      catch (error) { if (signal.aborted) throw error; return false; }
    }, { signal, timeoutMs: 600_000, label: 'Electron CDP endpoint' });
    browser = await chromium.connectOverCDP(debugging, { timeout: 10_000, ...(scenario.nativeWindowState ? { noDefaults: true } : {}) });
    const acquiredBrowser = browser;
    registerCleanup(() => acquiredBrowser.close());
    checkAlive();
    page = await waitUntil(() => {
      checkAlive();
      return browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(origin + '/'));
    }, { signal, timeoutMs: 600_000, label: 'Piora application window' });
    page.setDefaultTimeout(stepTimeoutMs);
    page.setDefaultNavigationTimeout(stepTimeoutMs);
    page.on('pageerror', error => pageErrors.push(error.message));
    ready = async () => {
      checkAlive();
      await abortable(() => page.locator('.app-shell').waitFor({ state: 'visible', timeout: 600_000 }), signal);
      // Either state is valid: the test supports a fresh or an already initialized profile.
      await waitUntil(async () => {
        checkAlive();
        const skip = page.getByRole('button', { name: /^(Skip guide|跳过引导)$/ });
        if (await skip.isVisible()) { await skip.click(); return false; }
        // The onboarding panel loads asynchronously after the shell/settings button.
        // Wait for its persisted decision so a late modal cannot cover the scenario.
        const onboarded = await page.evaluate(() => {
          const value = localStorage.getItem('piora-first-run-onboarding:v1');
          return value && ['dismissed', 'completed'].includes(JSON.parse(value).status);
        });
        if (!onboarded) return false;
        return await page.getByRole('button', { name: /^(Settings|设置)$/ }).isVisible();
      }, { signal, timeoutMs: stepTimeoutMs, label: 'settings entry after onboarding' });
    };
    await ready();
  };
  const connect = async () => {
    for (;;) {
      try { await connectOnce(); return; }
      catch (error) {
        // Dev compilation may replace Electron while the startup page is loading.
        // Only recover disconnected startup targets; scenario failures still propagate.
        if (signal.aborted || desktop.outcome() || (!page?.isClosed() && browser?.isConnected())) throw error;
        report.startupReconnects = (report.startupReconnects ?? 0) + 1;
        await browser?.close().catch(() => {});
      }
    }
  };
  await connect();
  return {
    page, origin, pageErrors,
    getBrowser: () => browser,
    // Restart only this run's owned process tree, retaining its isolated profile.
    restart: async () => {
      await browser.close(); await stopProcess(desktop); await checkPorts();
      desktop = start('scripts/dev-desktop.mjs');
      (report.restartPids ??= []).push(desktop.child.pid);
      await connect();
      return page;
    },
    reload: async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); },
    screenshot: name => page.screenshot({ path: join(directory, name), timeout: 5_000 }),
  };
}

/** launch is injectable for lifecycle tests; the CLI always uses the real Electron adapter. */
export async function runDesktopScenario({ root, scenario, timeoutMs = 600_000, stepTimeoutMs = 30_000,
  signal: externalSignal, failAt, port, debugPort, launch = launchDesktop, cleanupTimeoutMs = 15_000 }) {
  const parent = join(root, '.verification');
  await mkdir(parent, { recursive: true });
  const releaseLock = await acquireRunLock(join(parent, 'desktop-e2e.lock'));
  const cleanup = [];
  let directory;
  try { directory = await mkdtemp(join(parent, 'desktop-e2e-')); }
  catch (error) { await releaseLock(); throw error; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Desktop scenario exceeded ${timeoutMs} ms`)), timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const started = Date.now();
  const report = { version: 1, scenario: scenario.id, scope: scenario.scope, mode: scenario.mode ?? 'no-model',
    platform: process.platform, node: process.version, git: gitIdentity(root), startedAt: new Date(started).toISOString(),
    status: 'running', steps: [], cleanupErrors: [], pageErrors: [], failAt: failAt ?? null,
    coverage: scenario.coverage, limits: scenario.limits };
  cleanup.push(async () => {
    // A failed or timed-out cleanup may still own resources. Require inspection
    // before another run can reuse the checkout's shared development outputs.
    if (report.cleanupErrors.length) { report.lockRetained = true; return; }
    try { await releaseLock(); }
    catch (error) { report.lockRetained = true; throw error; }
  });
  let driver, currentStep = 'launch', finishing = false;
  async function step(name, work) {
    signal.throwIfAborted();
    const row = { name, status: 'running', startedAt: new Date().toISOString() };
    currentStep = name; report.steps.push(row);
    await writeFile(join(directory, 'progress.json'), JSON.stringify({ step: name, startedAt: row.startedAt }));
    const began = Date.now();
    try {
      // Launch owns cancellation of resource acquisition. Do not race it and run
      // cleanup while a late CDP connection is still acquiring resources.
      const value = name === 'launch' ? await work() : await abortable(work, signal);
      if (failAt === name) throw new Error(`Intentional failure at ${name}`);
      if (!finishing) { row.status = 'passed'; row.durationMs = Date.now() - began; }
      return value;
    } catch (error) { if (!finishing) { row.status = 'failed'; row.durationMs = Date.now() - began; } throw error; }
  }
  try {
    driver = await step('launch', () => launch({ root, directory, signal, report, stepTimeoutMs, port, debugPort, scenario,
      registerCleanup: fn => cleanup.push(fn) }));
    await abortable(() => scenario.run({ ...driver, directory, signal, step,
      waitUntil: (predicate, label) => waitUntil(predicate, { signal, timeoutMs: stepTimeoutMs, label }) }), signal);
    if (failAt && !report.steps.some(row => row.name === failAt)) throw new Error(`Failure injection step was not reached: ${failAt}`);
    if (driver.pageErrors.length) throw new Error('Uncaught renderer errors; see result.json');
    report.status = 'passed';
  } catch (error) {
    report.status = externalSignal?.aborted ? 'cancelled' : 'failed';
    report.failedStep = currentStep;
    report.error = { name: error.name, message: error.message };
    if (driver) await driver.screenshot('failure.png').catch(error => { report.screenshotError = error.message; });
  } finally {
    finishing = true; clearTimeout(timeout);
    report.pageErrors = driver?.pageErrors ?? [];
    for (const row of report.steps) if (row.status === 'running') row.status = 'interrupted';
    for (const close of cleanup.reverse()) {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Resource cleanup timed out')), cleanupTimeoutMs);
        })]);
      } catch (error) { report.cleanupErrors.push(error.message); }
      finally { clearTimeout(timer); }
    }
    if (report.cleanupErrors.length) report.status = 'failed';
    report.durationMs = Date.now() - started;
    report.finishedAt = new Date().toISOString();
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(directory, 'report.md'), `# Desktop test: ${scenario.id}\n\nStatus: **${report.status}**\n\nScope: ${scenario.scope}\n\n`
      + report.steps.map(row => `- ${row.name}: ${row.status} (${row.durationMs ?? 0} ms)`).join('\n')
      + `\n\n${report.error ? `Failure: ${report.error.message}\n\n` : ''}Cleanup errors: ${report.cleanupErrors.length}\nLock retained: ${Boolean(report.lockRetained)}\n\n`
      + `Coverage: ${scenario.coverage.join('; ')}\n\nNot covered: ${scenario.limits.join('; ')}\n`);
  }
  return { directory, report };
}
