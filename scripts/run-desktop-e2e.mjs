import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { stopShell, stopBash } from './desktop-e2e/scenarios/stop-shell.mjs';
import { settingsTheme } from './desktop-e2e/scenarios/settings-theme.mjs';
import { desktopExtensions } from './desktop-e2e/scenarios/desktop-extensions.mjs';
import { intelligentUiMiniApp } from './desktop-e2e/scenarios/intelligent-ui-mini-app.mjs';
import { intelligentUiWindow } from './desktop-e2e/scenarios/intelligent-ui-window.mjs';
import { intelligentUiRecovery } from './desktop-e2e/scenarios/intelligent-ui-recovery.mjs';
import { intelligentUiSessionLifecycle } from './desktop-e2e/scenarios/intelligent-ui-session-lifecycle.mjs';

const scenarios = [settingsTheme, stopShell, stopBash, desktopExtensions, intelligentUiMiniApp, intelligentUiWindow, intelligentUiRecovery, intelligentUiSessionLifecycle];

export function parseOptions(args) {
  const options = { scenario: 'settings-theme' };
  const names = { '--scenario': 'scenario', '--timeout-ms': 'timeoutMs', '--step-timeout-ms': 'stepTimeoutMs',
    '--port': 'port', '--debug-port': 'debugPort', '--fail-at': 'failAt' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '--list') { options[arg.slice(2)] = true; continue; }
    if (!names[arg] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${arg}`);
    const value = args[++index], key = names[arg];
    if (['port', 'debugPort', 'timeoutMs', 'stepTimeoutMs'].includes(key)) {
      const number = Number(value), isPort = key.endsWith('Port') || key === 'port';
      if (!Number.isInteger(number) || number < (isPort ? 1024 : 1) || number > (isPort ? 65535 : 3_600_000)) throw new Error(`Invalid ${arg}: ${value}`);
      options[key] = number;
    } else options[key] = value;
  }
  if (options.port && options.port === options.debugPort) throw new Error('Application and CDP ports must differ');
  if (!scenarios.some(scenario => scenario.id === options.scenario)) throw new Error(`Unknown scenario: ${options.scenario}`);
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || options.list) {
    console.log('Usage: npm run test:desktop:e2e -- [--scenario settings-theme|desktop-extensions|stop-shell|stop-bash|intelligent-ui-mini-app|intelligent-ui-window|intelligent-ui-recovery|intelligent-ui-session-lifecycle] [--timeout-ms 600000] [--step-timeout-ms 30000] [--port N] [--debug-port N] [--fail-at STEP]\nScenarios: settings-theme (no model), desktop-extensions (no model or download), stop-shell (local model fixture, real PowerShell), stop-bash (local model fixture, real Git Bash), intelligent-ui-mini-app (local model fixture, real mini app runtime and state), intelligent-ui-window (Windows native minimize/hide/restore, local model fixture; recovery scenario under development), intelligent-ui-recovery (lost response, stale review, cancellation and progress migration; local model fixture), intelligent-ui-session-lifecycle (copy, fork, static export and subtree trash/restore with pending state; local model fixture)');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Desktop test interrupted'));
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, stop);
  try {
    const scenario = scenarios.find(candidate => candidate.id === options.scenario);
    const result = await runDesktopScenario({ ...options, root: resolve(import.meta.dirname, '..'), scenario, signal: controller.signal });
    console.log(JSON.stringify({ status: result.report.status, directory: result.directory, failedStep: result.report.failedStep }));
    process.exitCode = result.report.status === 'passed' ? 0 : result.report.status === 'cancelled' ? 130 : 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
