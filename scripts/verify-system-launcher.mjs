import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(tmpdir(), 'piora-launcher-test-'));
try {
  await new Promise((resolve, reject) => {
    const env = { ...process.env, PIORA_LAUNCHER_TEST_HOME: root }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['scripts/system-launcher-fixture.cjs'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native launcher check timed out: ' + output)); }, 40_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); if (code) reject(new Error(output)); else { console.log(output.trim()); resolve(); } });
  });
} finally {
  assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('piora-launcher-test-'));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
