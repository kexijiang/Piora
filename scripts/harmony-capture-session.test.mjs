import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourceRoot = new URL('../third_party/harmony-mirror/entry/src/main/ets/', import.meta.url);

// ArkUI build syntax is not TypeScript. Execute actual method/callback bodies
// with their original imports; only the framework's StorageLink is mocked.
function blockAfter(source, marker) {
  const position = source.indexOf(marker);
  assert.notEqual(position, -1, `Missing fixture entry: ${marker}`);
  const start = source.indexOf('{', position + marker.length);
  assert.notEqual(start, -1, `Missing fixture body: ${marker}`);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  scanner.setTextPos(start);
  let depth = 0;
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (scanner.getToken() === ts.SyntaxKind.OpenBraceToken) depth++;
    if (scanner.getToken() === ts.SyntaxKind.CloseBraceToken && --depth === 0) return source.slice(start, scanner.getTextPos());
  }
  throw new Error(`Unclosed fixture body: ${marker}`);
}

async function fixture(options = {}) {
  const names = ['CapturePresence.ets', 'CaptureBackground.ets', 'CaptureSession.ets',
    'entryability/EntryAbility.ets', 'pages/MirrorPage.ets'];
  const sources = await Promise.all(names.map(name => readFile(new URL(name, sourceRoot), 'utf8')));
  const timers = new Map(), listeners = new Map(), displayListeners = new Map(), storage = new Map();
  const events = [], nativeStarts = [], nativeReconfigurations = [], taskStarts = [], releases = [];
  let now = 0, timerId = 0, nativeStops = 0, serverStops = 0;
  let accepted = options.accepted ?? true, started = false, presenceCallback, commandCallback, serverConfig;
  const screen = { width: 1440, height: 3120 };
  const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
  const manager = {
    on(event, callback) {
      if (options.failBackgroundListener) throw { code: 201 };
      listeners.set(event, callback);
    },
    off: event => listeners.delete(event),
    BackgroundTaskMode: { MODE_AV_PLAYBACK_AND_RECORD: 12 },
    BackgroundTaskSubmode: { SUBMODE_SCREEN_RECORD_NORMAL_NOTIFICATION: 7 },
    ContinuousTaskRequest: class {},
    async startBackgroundRunning(context, request) {
      taskStarts.push({ context, request });
      if (options.failTaskStart) throw { code: 201 };
      return { continuousTaskId: taskStarts.length };
    },
    async stopBackgroundRunning(context, id) { releases.push({ context, id }); }
  };
  const native = {
    startCapture(config) {
      events.push('native.start');
      nativeStarts.push({ config: { ...config }, requested: storage.get('mirrorCaptureRequested'), timerCount: timers.size });
      started = accepted && (options.startedOnAccept ?? false);
      return accepted;
    },
    stopCapture() { events.push('native.stop'); nativeStops++; started = false; },
    isCaptureStarted: () => started,
    startServer(port, config, onPresence, onCommand) {
      assert.equal(port, 53535);
      serverConfig = config;
      presenceCallback = onPresence;
      commandCallback = onCommand;
      return true;
    },
    stopServer() { serverStops++; },
    setEncoderPaused() {}, restartEncoder() {},
    reconfigureEncoder(config) {
      nativeReconfigurations.push({ ...config });
      const applied = options.reconfigureAccepted ?? false;
      if (!applied) { events.push('native.stop'); nativeStops++; started = false; }
      return applied;
    }
  };
  const display = {
    getDefaultDisplaySync: () => ({ ...screen }),
    on(event, callback) {
      assert.equal(event, 'change');
      assert.equal(typeof callback, 'function');
      displayListeners.set(event, callback);
    },
    off(event, callback) {
      assert.equal(event, 'change');
      if (displayListeners.get(event) === callback) displayListeners.delete(event);
    }
  };
  const modules = {
    '@kit.AbilityKit': {
      UIAbility: class { context = { owned: true }; },
      wantAgent: { OperationType: { START_ABILITY: 0 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 0 }, async getWantAgent() { return {}; } }
    },
    '@kit.ArkUI': {}, '@kit.BasicServicesKit': {},
    '@kit.BackgroundTasksKit': { backgroundTaskManager: manager },
    '@kit.PerformanceAnalysisKit': { hilog: { info() {}, error() {} } },
    '@ohos.display': { default: display },
    'libscrcpy_capture.so': native
  };
  const write = (key, value) => {
    if (key === 'mirrorCaptureRequested') events.push(`storage.requested:${value}`);
    storage.set(key, value);
  };
  const context = vm.createContext({
    Date: { now: () => now }, console: { error() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    AppStorage: { get: key => storage.get(key), set: write, setOrCreate: write }
  });
  function load(source, filename) {
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const fixtureModule = { exports: {} };
    const execute = vm.runInContext(`(function(exports, require, module) {\n${compiled}\n})`, context, { filename });
    execute(fixtureModule.exports, name => { assert.ok(modules[name], `Unmocked module ${name}`); return modules[name]; }, fixtureModule);
    return fixtureModule.exports;
  }
  modules['./CapturePresence'] = load(sources[0], names[0]);
  modules['./CaptureBackground'] = modules['../CaptureBackground'] = load(sources[1], names[1]);
  const session = modules['../CaptureSession'] = load(sources[2], names[2]);
  const presence = session.capturePresence, background = modules['./CaptureBackground'].captureBackground;
  for (const [object, method, event] of [[presence, 'cancelRequest', 'presence.cancel'],
    [presence, 'requestCapture', 'presence.request'], [background, 'stop', 'background.stop'],
    [background, 'request', 'background.request']]) {
    const original = object[method].bind(object);
    object[method] = (...args) => { events.push(event); return original(...args); };
  }
  const EntryAbility = load(sources[3], names[3]).default;
  const ability = new EntryAbility();
  ability.onCreate({});
  ability.onNewWant({});
  const pageSource = sources[4];
  const imports = pageSource.slice(0, pageSource.indexOf('@Entry'));
  const start = blockAfter(pageSource, 'private startSharing(): void');
  const stopAnchor = pageSource.indexOf(".id('piora-mirror-stop')");
  assert.notEqual(stopAnchor, -1, 'Missing stop button');
  const stop = blockAfter(pageSource.slice(stopAnchor), '.onClick(() =>');
  const Page = load(`${imports}\nexport class Page { startSharing(): void ${start}\nstopSharing(): void ${stop} }`, names[4]).Page;
  const page = new Page();
  Object.defineProperty(page, 'status', { get: () => storage.get('mirrorStatus'), set: value => write('mirrorStatus', value) });
  return {
    page, ability, session, presence, background, timers, listeners, displayListeners, storage, events,
    nativeStarts, nativeReconfigurations, taskStarts, releases,
    get nativeStops() { return nativeStops; }, get serverStops() { return serverStops; }, get serverConfig() { return serverConfig; },
    set accepted(value) { accepted = value; },
    present: value => presenceCallback(value), command: (sub, body) => commandCallback(sub, body), flush,
    displayChange(width, height) {
      screen.width = width; screen.height = height;
      displayListeners.get('change')?.(0);
    },
    async advance(ms) {
      const target = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])
          .find(([, timer]) => timer.at <= target);
        if (!next) break;
        assert.ok(++count < 10000, 'Timer loop failed to settle');
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

test('display rotation reconfigures an active capture and unregisters its listener on disposal', async () => {
  const f = await fixture({ reconfigureAccepted: true });
  assert.equal(f.displayListeners.size, 1);
  f.page.startSharing();
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  f.displayChange(3120, 1440);
  assert.deepEqual(f.nativeReconfigurations, [
    { width: 2340, height: 1080, frameRate: 30, bitrate: 6000000, jpegQuality: 70 }
  ]);
  assert.match(f.page.status, /画面已适配 2340 × 1080/);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  f.ability.onDestroy();
  assert.equal(f.displayListeners.size, 0);
});

function parameterBody(edge, bitrate, fps) {
  const body = new ArrayBuffer(12), data = new DataView(body);
  [edge, bitrate, fps].forEach((value, index) => data.setInt32(index * 4, value, false));
  return body;
}

test('native presence with no request preserves status and never stops or requests capture', async () => {
  const f = await fixture(), status = f.page.status;
  for (const present of [false, true, false, true]) f.present(present);
  await f.advance(60000);
  assert.equal(f.page.status, status);
  assert.equal(f.nativeStarts.length, 0);
  assert.equal(f.nativeStops, 0);
  assert.equal(f.taskStarts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('page start cancels the old session before native admission, then registers an accepted request', async () => {
  const f = await fixture();
  f.page.startSharing();
  const oldTimers = [...f.timers.values()].map(timer => timer.callback);
  f.events.length = 0;
  f.page.startSharing();
  assert.deepEqual(f.events.slice(0, 8), [
    'presence.cancel', 'storage.requested:false', 'background.stop', 'native.stop',
    'native.start', 'storage.requested:true', 'presence.request', 'background.request'
  ]);
  assert.equal(f.nativeStarts[1].requested, false);
  assert.equal(f.nativeStarts[1].timerCount, 0);
  assert.deepEqual(f.nativeStarts[1].config, { width: 1080, height: 2340, frameRate: 30, bitrate: 6000000, jpegQuality: 70 });
  oldTimers.forEach(callback => callback());
  assert.equal(f.nativeStops, 2);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  await f.advance(29999);
  assert.equal(f.nativeStops, 2);
  await f.advance(1);
  assert.equal(f.nativeStops, 3);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
});

test('the actual stop button fences queued false/true presence and absence callbacks', async () => {
  const f = await fixture({ startedOnAccept: true });
  f.page.startSharing();
  const oldTimers = [...f.timers.values()].map(timer => timer.callback);
  await f.advance(500);
  f.present(true);
  f.present(false);
  oldTimers.push(...[...f.timers.values()].map(timer => timer.callback));
  f.page.stopSharing();
  const status = f.page.status, stops = f.nativeStops;
  assert.match(status, /共享已停止/);
  for (const present of [false, true, false]) f.present(present);
  oldTimers.forEach(callback => callback());
  await f.advance(60000);
  assert.equal(f.page.status, status);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.nativeStops, stops);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.taskStarts.length, 1);
  assert.deepEqual(f.releases.map(value => value.id), [1]);
  assert.equal(f.releases[0].context, f.ability.context);
  assert.equal(f.timers.size, 0);
});

test('native admission false leaves no presence/background request and preserves the failure reason', async () => {
  const f = await fixture();
  f.page.startSharing();
  const stale = [...f.timers.values()].map(timer => timer.callback);
  f.accepted = false;
  f.events.length = 0;
  f.page.startSharing();
  const status = f.page.status, stops = f.nativeStops;
  assert.match(status, /共享请求失败/);
  assert.equal(f.events.includes('presence.request'), false);
  assert.equal(f.events.includes('background.request'), false);
  for (const present of [false, true, false]) f.present(present);
  stale.forEach(callback => callback());
  await f.advance(60000);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.page.status, status);
  assert.equal(f.nativeStops, stops);
  assert.equal(f.nativeStarts.length, 2);
  assert.equal(f.taskStarts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('real synchronous background failure is not overwritten by the page or late absence timeout', async () => {
  const f = await fixture({ failBackgroundListener: true });
  f.page.startSharing();
  const status = f.page.status, stops = f.nativeStops;
  assert.match(status, /后台录屏状态监听不可用/);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  await f.advance(30000);
  assert.equal(f.page.status, status);
  assert.equal(f.nativeStops, stops);
  for (const present of [false, true, false]) f.present(present);
  await f.advance(60000);
  assert.equal(f.page.status, status);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.taskStarts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('clearing request storage preserves an authorization reason through callbacks and timeout', async () => {
  const f = await fixture();
  f.page.startSharing();
  f.storage.set('mirrorCaptureRequested', false);
  f.storage.set('mirrorStatus', '授权已拒绝；请再次请求共享。');
  const status = f.page.status, stops = f.nativeStops;
  // Exercise the actual session timeout before transport cancels its timer.
  const absence = [...f.timers.values()].find(timer => timer.at === 30000).callback;
  absence();
  for (const present of [false, true, false]) f.present(present);
  f.background.stop();
  await f.advance(60000);
  assert.equal(f.page.status, status);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.nativeStops, stops);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.timers.size, 0);
});

test('real task rejection, cancellation and suspension preserve their final reason after late presence', async t => {
  for (const mode of ['rejection', 'cancellation', 'suspension']) {
    await t.test(mode, async () => {
      const f = await fixture({ startedOnAccept: true, failTaskStart: mode === 'rejection' });
      f.page.startSharing();
      await f.advance(500);
      if (mode !== 'rejection') {
        f.present(true);
        f.present(false);
        if (mode === 'cancellation') f.listeners.get('continuousTaskCancel')({ id: 1 });
        else f.listeners.get('continuousTaskSuspend')({ continuousTaskId: 1, suspendState: true });
      }
      const status = f.page.status, stops = f.nativeStops;
      assert.match(status, mode === 'rejection' ? /无法保持后台录屏/ : mode === 'cancellation' ? /系统已取消后台录屏/ : /系统已暂停后台录屏/);
      assert.equal(f.storage.get('mirrorCaptureRequested'), false);
      await f.advance(30000);
      for (const present of [false, true, false]) f.present(present);
      await f.advance(30000);
      assert.equal(f.page.status, status);
      assert.equal(f.nativeStops, stops);
      assert.equal(f.nativeStarts.length, 1);
      assert.equal(f.taskStarts.length, 1);
      assert.equal(f.timers.size, 0);
      if (mode !== 'rejection') assert.deepEqual(f.releases.map(value => value.id), [1]);
    });
  }
});

test('active capture survives a brief reconnect and stops once after a current five-second absence', async () => {
  const f = await fixture({ startedOnAccept: true });
  f.present(true);
  f.page.startSharing();
  f.present(true);
  await f.advance(500);
  f.present(false);
  const stale = [...f.timers.values()].find(timer => timer.at === 5500).callback;
  await f.advance(4999);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  f.present(true);
  stale();
  await f.advance(5000);
  assert.equal(f.nativeStops, 1);
  assert.equal(f.taskStarts.length, 1);
  f.present(false);
  await f.advance(4999);
  assert.equal(f.nativeStops, 1);
  await f.advance(1);
  assert.equal(f.nativeStops, 2);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.deepEqual(f.releases.map(value => value.id), [1]);
  const status = f.page.status;
  f.present(true);
  assert.equal(f.page.status, status);
  assert.equal(f.timers.size, 0);
});

test('a new offline page request replaces the old five-second timer with its own thirty-second deadline', async () => {
  const f = await fixture();
  f.present(true);
  f.page.startSharing();
  f.present(true);
  f.present(false);
  const stale = [...f.timers.values()].find(timer => timer.at === 5000).callback;
  await f.advance(4900);
  f.page.startSharing();
  stale();
  await f.advance(29999);
  assert.equal(f.nativeStops, 2);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  await f.advance(1);
  assert.equal(f.nativeStops, 3);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.nativeStarts.length, 2);
  assert.equal(f.timers.size, 0);
});

test('a previous viewer and its late close cannot shorten a fresh page request to five seconds', async () => {
  const f = await fixture();
  f.page.startSharing();
  f.present(true);
  f.page.startSharing();
  // Native stop shuts down old clients; their close may arrive after start returns.
  f.present(false);
  await f.advance(10000);
  f.present(false);
  await f.advance(19999);
  assert.equal(f.nativeStops, 2);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  await f.advance(1);
  assert.equal(f.nativeStops, 3);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.nativeStarts.length, 2);
  assert.equal(f.taskStarts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('an idle connected viewer remains valid for the first capture without another true notice', async () => {
  const f = await fixture({ startedOnAccept: true });
  f.present(true);
  f.page.startSharing();
  await f.advance(30001);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  assert.equal(f.nativeStops, 1);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.taskStarts.length, 1);
  f.present(false);
  await f.advance(4999);
  assert.equal(f.nativeStops, 1);
  await f.advance(1);
  assert.equal(f.nativeStops, 2);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.deepEqual(f.releases.map(value => value.id), [1]);
  assert.equal(f.timers.size, 0);
});

test('a failed changed native parameter update cancels the session and preserves the reauthorization reason', async () => {
  const f = await fixture();
  f.page.startSharing();
  const oldTimers = [...f.timers.values()].map(timer => timer.callback);
  const status = f.page.status, stops = f.nativeStops;
  for (const body of [new ArrayBuffer(11), parameterBody(239, 6000000, 30),
    parameterBody(1080, 12000001, 30), parameterBody(1080, 6000000, 61), parameterBody(1080, 6000000, 30)]) f.command(0x42, body);
  assert.equal(f.nativeStops, stops);
  assert.equal(f.page.status, status);
  assert.equal(f.storage.get('mirrorCaptureRequested'), true);
  f.command(0x42, parameterBody(720, 8000000, 24));
  const updated = f.page.status;
  assert.match(updated, /视频参数更新失败/);
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.nativeStops, stops + 1);
  assert.deepEqual({ ...f.serverConfig }, { width: 720, height: 1560, frameRate: 24, bitrate: 8000000, jpegQuality: 70 });
  oldTimers.forEach(callback => callback());
  for (const present of [false, true, false]) f.present(present);
  await f.advance(60000);
  assert.equal(f.page.status, updated);
  assert.equal(f.nativeStops, stops + 1);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.timers.size, 0);
});

test('ability disposal cancels controllers, releases the owned task and fences old callbacks', async () => {
  const f = await fixture({ startedOnAccept: true });
  f.present(true);
  f.page.startSharing();
  f.present(true);
  await f.advance(500);
  f.present(false);
  const oldTimers = [...f.timers.values()].map(timer => timer.callback), status = f.page.status;
  f.ability.onDestroy();
  const stops = f.nativeStops;
  assert.equal(f.storage.get('mirrorCaptureRequested'), false);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.serverStops, 1);
  oldTimers.forEach(callback => callback());
  for (const present of [false, true, false]) f.present(present);
  await f.advance(60000);
  assert.deepEqual(f.releases.map(value => value.id), [1]);
  assert.equal(f.releases[0].context, f.ability.context);
  assert.equal(f.page.status, status);
  assert.equal(f.nativeStops, stops);
  assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.taskStarts.length, 1);
  assert.equal(f.timers.size, 0);
});
