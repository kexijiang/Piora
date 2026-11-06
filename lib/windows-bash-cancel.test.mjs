import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { discoverWindowsBash } from './windows-bash.ts';
import { originalBashSource } from '../scripts/pi-windows-bash-patch.mjs';

const shellPath = discoverWindowsBash();
const windows = process.platform === 'win32' && Boolean(shellPath);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

// A newly forked MSYS child may not yet have a readable /proc winpid.
// Never publish a partial CHILD line or accept a failed/non-numeric read.
const reportChildPid = String.raw`report_child_pid() {
  local path="$1" winpid="" attempt
  for ((attempt=0; attempt<21; attempt++)); do
    if winpid=$(/usr/bin/cat "$path" 2>&1); then
      winpid=${'$'}{winpid//$'\r'/}
      if [[ "$winpid" =~ ^[1-9][0-9]*$ ]]; then
        printf "CHILD=%s\n" "$winpid"
        return 0
      fi
    fi
    if ((attempt < 20)); then /usr/bin/sleep 0.05; fi
  done
  printf "PID readiness failed for %s: %s\n" "$path" "$winpid" >&2
  return 1
}`;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('PID readiness shell fixture waits for a complete positive PID and fails closed', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piora-pid-readiness-'));
  const path = shellQuote(join(directory, 'winpid'));
  try {
    const result = await promisify(execFile)('/bin/bash', ['-c', `${reportChildPid}
      ( /usr/bin/sleep 0.1; printf "0\\n" > ${path}; /usr/bin/sleep 0.1; printf "12345\\r\\n" > ${path} ) &
      report_child_pid ${path}; result=$?; wait; exit "$result"`], { timeout: 5000 });
    assert.equal(result.stdout, 'CHILD=12345\n');
    assert.equal(result.stderr, '');
    // Exercise the same quoting used by the nested-pipeline and exec-nested cases.
    for (const command of [
      `bash -c ${shellQuote(`${reportChildPid}\nreport_child_pid ${path}`)} | cat`,
      `exec bash -c ${shellQuote(`${reportChildPid}\nreport_child_pid ${path}`)}`,
    ]) {
      const nested = await promisify(execFile)('/bin/bash', ['-c', command], { timeout: 3000 });
      assert.equal(nested.stdout, 'CHILD=12345\n');
      assert.equal(nested.stderr, '');
    }
    for (const value of ['', '0', 'not-a-pid', '12 34']) {
      await assert.rejects(promisify(execFile)('/bin/bash', ['-c', `${reportChildPid}
        printf "%s" ${shellQuote(value)} > ${path}; report_child_pid ${path}`], { timeout: 3000 }), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /PID readiness failed/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviewed SDK patch is reversible and rejects altered original or cleanup code', async () => {
  const source = await readFile('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js', 'utf8');
  assert.match(source, /Piora #243/);
  assert.doesNotMatch(originalBashSource(source), /Piora #243/);
  assert.throws(() => originalBashSource(source.replace('const MAX_TIMEOUT_MS', 'const ALTERED_TIMEOUT_MS')), /Unexpected Pi Bash source/);
  assert.throws(() => originalBashSource(source.replace("'ps.exe'", "'bad.exe'")), /Unexpected Piora Bash cleanup helper/);
});

for (const mode of ['abort', 'timeout', 'nested-pipeline', 'exec', 'exec-nested']) {
  test(`Windows Bash ${mode} stops actual descendants without killing unrelated sleep`, { skip: !windows, timeout: 15000 }, async t => {
    // This process is outside the command's MSYS ancestry and must survive.
    const unrelated = spawn(shellPath.replace(/bin[\\/]bash.exe$/i, 'usr/bin/sleep.exe'), ['30'], { windowsHide: true, stdio: 'ignore' });
    t.after(() => { if (unrelated.pid && alive(unrelated.pid)) unrelated.kill(); });
    await new Promise((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject); });
    const controller = new AbortController();
    let output = '';
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const pids = [];
    t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid); });
    const body = `${reportChildPid}
sleep 30 & sleeper=$!; report_child_pid /proc/$sleeper/winpid || { kill "$sleeper"; wait "$sleeper"; exit 1; }; wait; echo COMPLETED`;
    const command = mode === 'exec' ? `${reportChildPid}
echo MSYS=$$; report_child_pid /proc/$$/winpid || exit 1; exec sleep 30` : mode === 'nested-pipeline' ? `bash -c ${shellQuote(body)} | cat` : mode === 'exec-nested' ? `exec bash -c ${shellQuote(body)}` : body;
    const execution = createLocalBashOperations({ shellPath }).exec(command, process.cwd(), {
      signal: controller.signal, timeout: mode === 'timeout' ? 2 : 10,
      onData: data => {
        output += data.toString();
        const match = output.match(/CHILD=(\d+)\r?\n/);
        if (match && !pids.length) { pids.push(Number(match[1])); ready(); }
      },
    });
    // Observe rejection immediately, including when readiness itself fails.
    const outcome = execution.then(value => ({ value }), error => ({ error }));
    let readinessTimer;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        readinessTimer = setTimeout(() => reject(new Error('Sleep PID was not reported')), 5000);
      })]);
      clearTimeout(readinessTimer);
      if (mode === 'exec') {
        // MSYS exec preserves its POSIX PID but replaces its Windows PID.
        await delay(150);
        const msysPid = Number(output.match(/MSYS=(\d+)/)[1]);
        const result = await promisify(execFile)(shellPath, ['-c', `cat /proc/${msysPid}/winpid`], { windowsHide: true });
        pids.splice(0, pids.length, Number(result.stdout.trim()));
      }
      assert.ok(alive(pids[0]));
      const cancellingAt = Date.now();
      if (mode !== 'timeout') controller.abort();
      const result = await outcome;
      assert.ok(result.error, 'Execution must reject cancellation');
      assert.match(String(result.error), mode === 'timeout' ? /timeout:2/ : /aborted/);
      assert.ok(Date.now() - cancellingAt < 3000, 'Cancellation must finish promptly');
      assert.equal(alive(pids[0]), false, 'Descendant must be gone when execution settles');
      assert.ok(alive(unrelated.pid), 'Unrelated sleep must remain alive');
      assert.doesNotMatch(output, /COMPLETED/);
    } catch (error) {
      // SDK onData combines stdout and stderr; preserve both for diagnosis.
      t.diagnostic(`Captured Bash stdout/stderr: ${JSON.stringify(output)}`);
      throw error;
    } finally {
      clearTimeout(readinessTimer);
      controller.abort();
      await outcome;
    }
  });
}

test('Windows Bash preserves ordinary output and exit status; pre-aborted work never starts', { skip: !windows }, async () => {
  const operations = createLocalBashOperations({ shellPath });
  let output = '';
  assert.deepEqual(await operations.exec('printf hello; exit 7', process.cwd(), { onData: data => { output += data; } }), { exitCode: 7 });
  assert.equal(output, 'hello');
  await assert.rejects(operations.exec('echo SHOULD_NOT_RUN', process.cwd(), { signal: AbortSignal.abort(), onData: () => assert.fail() }), /aborted/);
});
