import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { HarmonyError } = await jiti.import('./errors.ts');
const { validateDeviceFilePath } = await jiti.import('./device-files.ts');
const source = await readFile(new URL('./device-terminal.ts', import.meta.url), 'utf8');

function runtime() {
  const children = [], leases = new Map([['owner-a', { token: 'owner-a', serial: 'phone', owner: { kind: 'manual' } }],
    ['owner-b', { token: 'owner-b', serial: 'phone', owner: { kind: 'manual' } }]]);
  const manager = {
    renewLease(token) { const lease = leases.get(token); if (!lease) throw new HarmonyError('LEASE_REQUIRED', 'expired'); return lease; },
    async listDevices() { return [{ serial: 'phone', state: 'online' }]; },
    getState() { return { leases: [...leases.values()], runtime: { hdcPath: 'owned-test-hdc' } }; },
  };
  const timers = new Set(), exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, process: { cwd: () => 'owned-test-cwd', env: {}, platform: 'win32' },
    setInterval(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
    require(name) {
      if (name === 'node:crypto') return { randomUUID };
      if (name === './errors') return { HarmonyError };
      if (name === './device-files') return { validateDeviceFilePath };
      if (name === './index') return { getHarmonyDeviceManager: () => manager };
      if (name === '../terminal-pty') return { loadTerminalPty: () => ({ spawn(executable, args) {
        const child = { executable, args: [...args], writes: [], kills: 0, resizes: [],
          onData(callback) { this.data = callback; }, onExit(callback) { this.exited = callback; },
          write(data) { this.writes.push(data); }, kill() { this.kills++; }, resize(...size) { this.resizes.push(size); } };
        children.push(child); return child;
      } }) };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { api: exports, children, leases, timers };
}

test('separate tabs retain independent PTYs and duplicate starts reuse only their own tab', async () => {
  const { api, children } = runtime();
  const one = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-one');
  const two = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-two');
  assert.notEqual(one, two); assert.equal(children.length, 2);
  assert.equal(await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-one'), one);
  api.controlDeviceTerminal(one, 'owner-a', 'input', 'export OWNED_TAB=one\r');
  api.controlDeviceTerminal(two, 'owner-a', 'input', 'export OWNED_TAB=two\r');
  assert.deepEqual(children[0].writes, ['export OWNED_TAB=one\r']);
  assert.deepEqual(children[1].writes, ['export OWNED_TAB=two\r']);
  api.controlDeviceTerminal(one, 'owner-a', 'stop');
  assert.equal(children[0].kills, 1); assert.equal(children[1].kills, 0);
  api.controlDeviceTerminal(two, 'owner-a', 'input', 'pwd\r');
  assert.equal(children[1].writes.at(-1), 'pwd\r');
});

test('changing a tab scope replaces only that tab and passes sandbox arguments to HDC', async () => {
  const { api, children } = runtime();
  const one = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-one');
  const two = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-two');
  const replacement = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'sandbox', bundleName: 'dev.piora.owned' }, 'tab-one');
  assert.notEqual(replacement, one); assert.equal(children[0].kills, 1); assert.equal(children[1].kills, 0);
  assert.deepEqual(children[2].args, ['-t', 'phone', 'shell', '-b', 'dev.piora.owned']);
  assert.equal(api.getDeviceTerminal(two).isConnected(), true);
});

test('concurrent starts remain bounded to eight independent sessions per device', async () => {
  const { api, children } = runtime();
  const starts = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, `tab-${index}`)));
  assert.equal(starts.filter(item => item.status === 'fulfilled').length, 8);
  assert.equal(starts.filter(item => item.status === 'rejected').length, 1);
  assert.equal(starts.find(item => item.status === 'rejected').reason.code, 'DEVICE_BUSY');
  assert.equal(children.length, 8);
});

test('another owner cannot start, input or stop a live tab', async () => {
  const { api, children } = runtime();
  const id = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-one');
  await assert.rejects(api.startDeviceTerminal('phone', 'owner-b', { kind: 'shared' }, 'tab-two'), error => error.code === 'LEASE_CONFLICT');
  assert.throws(() => api.controlDeviceTerminal(id, 'owner-b', 'input', 'pwd\r'), error => error.code === 'LEASE_REQUIRED');
  assert.throws(() => api.controlDeviceTerminal(id, 'owner-b', 'stop'), error => error.code === 'LEASE_REQUIRED');
  assert.equal(children.length, 1); assert.equal(children[0].kills, 0); assert.deepEqual(children[0].writes, []);
});

test('expired leases close all their tabs and malformed identities never spawn a PTY', async () => {
  const { api, children, leases, timers } = runtime();
  for (const identity of ['', '../escape', 'x'.repeat(129)]) {
    await assert.rejects(api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, identity), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(children.length, 0);
  const one = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-one');
  const two = await api.startDeviceTerminal('phone', 'owner-a', { kind: 'shared' }, 'tab-two');
  leases.delete('owner-a'); for (const timer of [...timers]) timer.callback();
  assert.deepEqual(children.map(child => child.kills), [1, 1]);
  assert.throws(() => api.getDeviceTerminal(one)); assert.throws(() => api.getDeviceTerminal(two));
});
