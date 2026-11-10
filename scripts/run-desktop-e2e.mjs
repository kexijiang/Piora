import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { stopShell, stopBash } from './desktop-e2e/scenarios/stop-shell.mjs';
import { settingsTheme } from './desktop-e2e/scenarios/settings-theme.mjs';
import { browserPersistence } from './desktop-e2e/scenarios/browser-persistence.mjs';
import { browserLogin } from './desktop-e2e/scenarios/browser-login.mjs';
import { desktopExtensions } from './desktop-e2e/scenarios/desktop-extensions.mjs';
import { harmonyMirror } from './desktop-e2e/scenarios/harmony-mirror.mjs';
import { companionPanel } from './desktop-e2e/scenarios/companion-panel.mjs';

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
  if (![settingsTheme.id, stopShell.id, stopBash.id, desktopExtensions.id, browserPersistence.id, browserLogin.id, harmonyMirror.id, companionPanel.id].includes(options.scenario)) throw new Error(`Unknown scenario: ${options.scenario}`);
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || options.list) {
    console.log('Usage: npm run test:desktop:e2e -- [--scenario settings-theme|desktop-extensions|stop-shell|stop-bash|browser-persistence|browser-login|harmony-mirror|companion-panel] [--timeout-ms 600000] [--step-timeout-ms 30000] [--port N] [--debug-port N] [--fail-at STEP]\nScenarios: settings-theme (no model), desktop-extensions (no model or download), stop-shell (local model fixture, real PowerShell), stop-bash (local model fixture, real Git Bash), browser-persistence (local website fixture), browser-login (local model and login fixture), harmony-mirror (authorized HDC device, no model), companion-panel (Turbopack clipboard, no model)');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Desktop test interrupted'));
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, stop);
  try {
    const scenario = [settingsTheme, stopShell, stopBash, desktopExtensions, browserPersistence, browserLogin, harmonyMirror, companionPanel].find(candidate => candidate.id === options.scenario);
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
