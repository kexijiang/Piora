import { spawn } from 'node:child_process';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function abortable(work, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

export async function waitUntil(predicate, { signal, timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = new AbortController();
  // A referenced timer also bounds a predicate that never settles and owns no handles.
  const timer = setTimeout(() => deadline.abort(new Error('Wait deadline exceeded')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    while (true) {
      const value = await abortable(predicate, combined);
      if (value) return value;
      await delay(intervalMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.signal.aborted) throw new Error(`Timed out waiting for ${label}`, { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

/** Only OS/runtime essentials: never inherit provider keys, Node injection or Pi overrides. */
export function isolatedEnvironment(source, paths) {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programw6432|systemdrive|processor_architecture|processor_identifier|number_of_processors|lang|lc_all|display|xauthority|wayland_display|xdg_runtime_dir|dbus_session_bus_address)$/i;
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.test(key) && typeof value === 'string')),
    PIORA_DESKTOP_DEV_USER_DATA: paths.profile,
    PI_CODING_AGENT_DIR: paths.agent,
    PIORA_DEV_DIST_DIR: paths.dist,
    PIORA_DEV_TSCONFIG: paths.tsconfig,
    PIORA_DESKTOP_DEV_PORT: String(paths.port),
    PIORA_DESKTOP_DEV_DEBUG_PORT: String(paths.debugPort),
    PIORA_DESKTOP_DEV_COMPILE_ONCE: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export async function acquireRunLock(directory) {
  try { await mkdir(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another desktop test owns ${directory}. Inspect owner.json; remove a stale lock only after its process has stopped.`);
  }
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  const path = join(directory, 'owner.json');
  try { await writeFile(path, JSON.stringify(owner), { flag: 'wx' }); }
  catch (error) { await rmdir(directory).catch(() => {}); throw error; }
  return async () => {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.token !== owner.token) throw new Error('Desktop test lock ownership changed; leaving it intact');
    await unlink(path);
    await rmdir(directory);
  };
}

export async function reservePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return { port: server.address().port, release: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', windowsHide: true });
  // Observe errors immediately, including ENOENT before a caller starts waiting.
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let outcome;
  void exited.then(value => { outcome = value; });
  return { child, exited, outcome: () => outcome };
}

async function exitsWithin(exited, ms) {
  let timer;
  try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

export async function stopProcess(handle) {
  const { child, exited } = handle;
  if (!child.pid || handle.outcome()) return;
  if (process.platform === 'win32') {
    const killer = startProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (!await exitsWithin(killer.exited, 10_000)) { killer.child.kill(); throw new Error('taskkill timed out'); }
  } else {
    // dev-desktop owns separate child groups; give its SIGTERM handler time to stop them.
    try { child.kill('SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await exitsWithin(exited, 10_000)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (!await exitsWithin(exited, 5_000)) throw new Error(`Process ${child.pid} did not exit`);
}
