import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readGitHubBuildOrigin } from './harmony-mirror-provenance.mjs';
import {
  attachDeviceAcceptance,
  MIRROR_BUNDLE,
  MIRROR_HAP_FILE,
  readAndVerifySignatureReceipt,
  resolveHarmonyReleaseTools,
} from './harmony-mirror-release.mjs';

const fail = message => { throw new Error(`Harmony mirror device acceptance: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_OUTPUT = 4 * 1024 * 1024;
const DEVICE_PORT = 53_535;

function hdc(tool, serial, args, options = {}) {
  const result = spawnSync(tool, ['-t', serial, ...args], {
    encoding: options.encoding ?? 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 20_000,
    maxBuffer: MAX_OUTPUT,
  });
  if (result.error || result.status !== 0) {
    const output = Buffer.isBuffer(result.stdout) ? Buffer.concat([result.stdout, result.stderr ?? Buffer.alloc(0)]).toString('utf8')
      : `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    fail(`${options.label ?? args[0]} failed${result.status === null ? '' : ` with exit ${result.status}`}\n${output.slice(-4_000)}`);
  }
  const output = Buffer.isBuffer(result.stdout) ? Buffer.concat([result.stdout, result.stderr ?? Buffer.alloc(0)]).toString('utf8')
    : `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // HDC has versions where a remote-side failure is reported in text while
  // the client process still exits zero. Critical acceptance cannot trust that
  // exit status alone.
  if (/\[Fail\]|\bfailed\b|\berror\b|\binvalid\b/i.test(output)) {
    fail(`${options.label ?? args[0]} reported failure despite exit zero\n${output.slice(-4_000)}`);
  }
  return result;
}

function clean(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replaceAll('\0', '').trim();
}

function requiredText(result, label) {
  const output = clean(result);
  if (!output) fail(`${label} returned no confirmation`);
  return output;
}

function forwardRule(localPort) {
  return new RegExp(`(?:^|\\s)tcp:${localPort}\\s+tcp:${DEVICE_PORT}(?:\\s|$)`, 'm');
}

function findBounds(value) {
  if (typeof value === 'string') {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.slice(0, 4).map(Number);
    if (numbers?.length === 4 && numbers.every(Number.isFinite)) return { left: numbers[0], top: numbers[1], right: numbers[2], bottom: numbers[3] };
  }
  if (Array.isArray(value) && value.length >= 4) {
    const numbers = value.slice(0, 4).map(Number);
    if (numbers.every(Number.isFinite)) return { left: numbers[0], top: numbers[1], right: numbers[2], bottom: numbers[3] };
  }
  if (value && typeof value === 'object') {
    const left = Number(value.left ?? value.leftTopX ?? value.x1 ?? value.startX);
    const top = Number(value.top ?? value.leftTopY ?? value.y1 ?? value.startY);
    const right = Number(value.right ?? value.rightBottomX ?? value.x2 ?? value.endX);
    const bottom = Number(value.bottom ?? value.rightBottomY ?? value.y2 ?? value.endY);
    if ([left, top, right, bottom].every(Number.isFinite)) return { left, top, right, bottom };
  }
}

function flatten(tree, maximum = 10_000) {
  const nodes = [];
  const visited = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value) || nodes.length >= maximum) return;
    visited.add(value);
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const attrs = value.attributes && typeof value.attributes === 'object' && !Array.isArray(value.attributes) ? value.attributes : {};
    const merged = { ...value, ...attrs };
    if (['attributes', 'bounds', 'rect', 'text', 'id', 'key', 'type', 'children', 'clickable'].some(key => key in value)) {
      nodes.push({
        text: merged.text ?? merged.content ?? merged.value,
        id: merged.id ?? merged.accessibilityId ?? merged.key ?? merged.resourceId ?? merged.inspectorId ?? merged.uniqueId ?? merged.componentId,
        clickable: merged.clickable === true || merged.clickable === 'true' || merged.clickable === 1 || merged.clickable === '1',
        bounds: findBounds(merged.bounds ?? merged.rect ?? merged.bound ?? merged.visibleBounds ?? merged.boundsInScreen ?? merged.origBounds),
      });
    }
    for (const [key, nested] of Object.entries(value)) if (key !== 'attributes' && nested && typeof nested === 'object') visit(nested);
  };
  visit(tree);
  return nodes;
}

async function layout(hdcPath, serial, directory, name) {
  const remote = `/data/local/tmp/piora-${name}-${process.pid}.json`;
  const local = join(directory, `${name}.json`);
  try {
    hdc(hdcPath, serial, ['shell', 'uitest', 'dumpLayout', '-p', remote], { label: 'fresh UI layout dump' });
    hdc(hdcPath, serial, ['file', 'recv', remote, local], { label: 'fresh UI layout receive' });
    return flatten(JSON.parse(await readFile(local, 'utf8')));
  } finally {
    try { hdc(hdcPath, serial, ['shell', 'rm', remote], { label: 'layout cleanup', timeout: 5_000 }); } catch { /* final package cleanup remains authoritative */ }
  }
}

async function waitForNode(hdcPath, serial, directory, name, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await layout(hdcPath, serial, directory, `${name}-${Date.now()}`);
    const node = last.find(predicate);
    if (node) return { node, nodes: last };
    await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
  }
  fail(`fresh device UI did not expose ${name}; observed ids: ${last.map(node => node.id).filter(Boolean).slice(0, 20).join(', ')}`);
}

function clickObserved(hdcPath, serial, node, label) {
  const bounds = node?.bounds;
  if (!node?.clickable || !bounds || bounds.left < 0 || bounds.top < 0 || bounds.right > 32_768 || bounds.bottom > 32_768
    || bounds.right <= bounds.left || bounds.bottom <= bounds.top) fail(`${label} is not a fresh clickable device node`);
  const x = Math.round((bounds.left + bounds.right) / 2);
  const y = Math.round((bounds.top + bounds.bottom) / 2);
  hdc(hdcPath, serial, ['shell', 'uitest', 'uiInput', 'click', String(x), String(y)], { label });
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('cannot reserve a loopback port')); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function packet(type, payload) {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(type, 0);
  output.writeUInt32BE(payload.length, 4);
  payload.copy(output, 8);
  return output;
}

function h264Units(bytes) {
  const starts = [];
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0) continue;
    const size = bytes[index + 2] === 1 ? 3
      : index + 3 < bytes.length && bytes[index + 2] === 0 && bytes[index + 3] === 1 ? 4 : 0;
    if (!size) continue;
    starts.push({ at: index, size });
    index += size - 1;
  }
  if (!starts.length) return bytes.length ? [bytes] : [];
  return starts.map((start, index) => bytes.subarray(start.at + start.size, starts[index + 1]?.at ?? bytes.length))
    .filter(unit => unit.length > 0);
}

/** Parse the production config packet and reject RAW/JPEG fallback as H.264 evidence. */
export function validateH264Configuration(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 17 || payload[0] !== 0) fail('video stream did not negotiate H.264');
  const width = payload.readUInt32BE(1);
  const height = payload.readUInt32BE(5);
  const fps = payload.readUInt32BE(9);
  if (width < 100 || height < 100 || width > 8192 || height > 8192 || fps < 1 || fps > 120) {
    fail('H.264 configuration has invalid geometry or frame rate');
  }
  const spsLength = payload.readUInt16BE(13);
  const ppsLengthOffset = 15 + spsLength;
  if (spsLength < 4 || spsLength > 4096 || ppsLengthOffset + 2 > payload.length) fail('H.264 configuration has an invalid SPS boundary');
  const ppsLength = payload.readUInt16BE(ppsLengthOffset);
  if (ppsLength < 1 || ppsLength > 4096 || ppsLengthOffset + 2 + ppsLength !== payload.length) fail('H.264 configuration has an invalid PPS boundary');
  const spsUnits = h264Units(payload.subarray(15, ppsLengthOffset));
  const ppsUnits = h264Units(payload.subarray(ppsLengthOffset + 2));
  if (spsUnits.length !== 1 || ppsUnits.length !== 1 || (spsUnits[0][0] & 0x1f) !== 7 || (ppsUnits[0][0] & 0x1f) !== 8) {
    fail('H.264 configuration does not contain one SPS and one PPS');
  }
  return { width, height, fps, bytes: Buffer.from(payload) };
}

/** Accept only timestamped AVC slice packets whose key flag agrees with an IDR NAL. */
export function validateH264Frame(payload, previousTimestamp, requireKeyframe = false) {
  if (!Buffer.isBuffer(payload) || payload.length <= 9 || (payload[0] & 0xfe) !== 0) fail('H.264 frame payload is malformed');
  const timestamp = payload.readBigUInt64BE(1);
  if (timestamp === 0n || (previousTimestamp !== undefined && timestamp <= previousTimestamp)) fail('H.264 frame timestamps are not strictly increasing');
  const units = h264Units(payload.subarray(9));
  if (!units.length || units.some(unit => (unit[0] & 0x80) !== 0)) fail('H.264 frame contains an invalid NAL unit');
  const types = units.map(unit => unit[0] & 0x1f);
  const idr = types.includes(5);
  const picture = idr || types.includes(1);
  const keyframe = payload[0] === 1;
  if (!picture || keyframe !== idr || (requireKeyframe && !idr)) fail('H.264 frame key flag or slice type is invalid');
  return { timestamp, keyframe };
}

async function observeVideo(port) {
  return await new Promise((resolveVideo, rejectVideo) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0), configurationPackets = 0, frames = 0, keyframes = 0, bytes = 0;
    let configuration, lastTimestamp, settled = false;
    const timeout = setTimeout(() => finish(new Error(`video evidence incomplete (config=${configurationPackets}, frames=${frames}, keyframes=${keyframes})`)), 35_000);
    const heartbeat = setInterval(() => {
      if (socket.writable) {
        const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(Date.now())); socket.write(packet(0x01, payload));
      }
    }, 2_000);
    const cleanup = () => { clearTimeout(timeout); clearInterval(heartbeat); socket.removeAllListeners(); socket.destroy(); };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectVideo(error);
      else resolveVideo({ codec: 'h264', width: configuration.width, height: configuration.height,
        fps: configuration.fps, configurationPackets, frames, keyframes, bytes });
    };
    socket.once('error', finish);
    socket.once('connect', () => {
      const settings = Buffer.alloc(13); settings[0] = 0x42; settings.writeInt32BE(1080, 1); settings.writeInt32BE(6_000_000, 5); settings.writeInt32BE(30, 9);
      socket.write(packet(0x10, settings));
      socket.write(packet(0x10, Buffer.from([0x43])));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const type = buffer.readUInt32BE(0), length = buffer.readUInt32BE(4);
        if (length > 24 * 1024 * 1024) { finish(new Error('video packet exceeds the bounded protocol limit')); return; }
        if (buffer.length < 8 + length) break;
        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);
        try {
          if (type === 0x02) {
            const next = validateH264Configuration(payload);
            if (configuration && !configuration.bytes.equals(next.bytes)) fail('H.264 configuration changed during acceptance');
            configuration = next;
            configurationPackets += 1;
            bytes += 8 + length;
          } else if (type === 0x03) {
            if (!configuration) fail('H.264 frame arrived before a valid configuration');
            const frame = validateH264Frame(payload, lastTimestamp, frames === 0);
            lastTimestamp = frame.timestamp;
            frames += 1;
            if (frame.keyframe) keyframes += 1;
            bytes += 8 + length;
          }
        } catch (error) {
          finish(error);
          return;
        }
        if (configurationPackets >= 1 && frames >= 15 && keyframes >= 1) finish();
      }
    });
  });
}

async function captureScreenshot(hdcPath, serial, directory) {
  const remote = `/data/local/tmp/piora-acceptance-${process.pid}.png`;
  const local = join(directory, 'device-screenshot.png');
  try {
    hdc(hdcPath, serial, ['shell', 'uitest', 'screenCap', '-p', remote], { label: 'device screenshot' });
    hdc(hdcPath, serial, ['file', 'recv', remote, local], { label: 'device screenshot receive' });
    const bytes = await readFile(local);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) fail('device screenshot is not a valid PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 100 || height < 100) fail('device screenshot has implausible dimensions');
    return { png: true, size: bytes.length, sha256: hash(bytes), width, height };
  } finally {
    try { hdc(hdcPath, serial, ['shell', 'rm', remote], { label: 'screenshot cleanup', timeout: 5_000 }); } catch { /* final cleanup still runs */ }
  }
}

export async function verifyHarmonyMirrorOnDevice({ projectRoot, resourcesDirectory, serial, environment = process.env }) {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial ?? '')) fail('a valid dedicated HDC serial is required');
  const origin = readGitHubBuildOrigin(projectRoot, environment);
  await readAndVerifySignatureReceipt(resourcesDirectory, origin);
  const tools = await resolveHarmonyReleaseTools(environment);
  const temporary = await mkdtemp(join(tmpdir(), 'piora-harmony-release-acceptance-'));
  const localPort = await freePort();
  let forwardCreated = false, forwardRemoved = false, installAttempted = false, packageAbsent = false, evidence, operationError;
  try {
    const lock = requiredText(hdc(tools.hdc, serial, ['shell', 'hidumper', '-s', 'ScreenlockService', '-a', '-all'], { label: 'screen lock check' }), 'screen lock check');
    if (!/^\s*\*?\s*screenLocked\s*[:= ]\s*false\b/im.test(lock)) fail('the dedicated phone must already be unlocked');
    const beforeInstall = requiredText(hdc(tools.hdc, serial, ['shell', 'bm', 'dump', '-a'], { label: 'pre-install package absence check', timeout: 15_000 }), 'pre-install package absence check');
    if (beforeInstall.includes(MIRROR_BUNDLE)) fail('the dedicated phone already contains the mirror bundle; refusing to replace it');
    packageAbsent = true;

    const hap = resolve(resourcesDirectory, MIRROR_HAP_FILE);
    installAttempted = true;
    const install = clean(hdc(tools.hdc, serial, ['install', hap], { label: 'signed HAP install', timeout: 60_000 }));
    if (/\b(?:fail|error|invalid signature|verify pkcs7)\b/i.test(install) || !/success/i.test(install)) fail('the phone did not confirm the signed HAP installation');
    packageAbsent = false;
    const manifest = await jsonFileForDevice(join(resourcesDirectory, 'harmony-mirror-manifest.json'));
    const installed = clean(hdc(tools.hdc, serial, ['shell', 'bm', 'dump', '-n', MIRROR_BUNDLE], { label: 'installed package verification' }));
    if (!installed.includes(MIRROR_BUNDLE)
      || !installed.includes(String(manifest.artifact.component.versionName))
      || !installed.includes(String(manifest.artifact.component.versionCode))) {
      fail('installed package identity or version was not verified');
    }
    const launch = clean(hdc(tools.hdc, serial, ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', MIRROR_BUNDLE], { label: 'mirror launch' }));
    if (/\b(?:fail|error)\b/i.test(launch) || !/success/i.test(launch)) fail('the phone did not confirm the foreground launch');

    const start = await waitForNode(tools.hdc, serial, temporary, 'owned start button', node => node.id === 'piora-mirror-start'
      && node.clickable && typeof node.text === 'string' && /开始共享屏幕|start (?:screen )?sharing|share (?:the )?screen/i.test(node.text));
    clickObserved(tools.hdc, serial, start.node, 'fresh owned start button');
    const consent = await waitForNode(tools.hdc, serial, temporary, 'owned system consent', node => node.id === 'advanced_dialog_button_1'
      && node.clickable && typeof node.text === 'string' && /允许|allow/i.test(node.text));
    if (!consent.nodes.some(node => typeof node.text === 'string' && /Piora/i.test(node.text) && /屏幕|screen/i.test(node.text))) fail('system consent does not visibly name the owned Piora screen share');
    clickObserved(tools.hdc, serial, consent.node, 'fresh system allow button');
    const dismissed = await layout(tools.hdc, serial, temporary, `consent-dismissed-${Date.now()}`);
    if (dismissed.some(node => node.id === 'advanced_dialog_button_1')) fail('system consent did not dismiss');

    const forward = requiredText(hdc(tools.hdc, serial, ['fport', `tcp:${localPort}`, `tcp:${DEVICE_PORT}`], { label: 'owned video forward' }), 'owned video forward');
    if (!/Forwardport result:\s*OK/i.test(forward)) fail('HDC did not explicitly confirm the owned video forward');
    const listedForward = requiredText(hdc(tools.hdc, serial, ['fport', 'ls'], { label: 'owned video forward verification' }), 'owned video forward verification');
    if (!forwardRule(localPort).test(listedForward)) fail('the owned video forward was not present after creation');
    forwardCreated = true;
    const [video, screenshot] = await Promise.all([observeVideo(localPort), captureScreenshot(tools.hdc, serial, temporary)]);
    evidence = { video, screenshot };
  } catch (error) {
    operationError = error;
  } finally {
    if (forwardCreated) {
      try {
        const removedForward = requiredText(hdc(tools.hdc, serial, ['fport', 'rm', `tcp:${localPort}`, `tcp:${DEVICE_PORT}`], { label: 'owned forward cleanup', timeout: 8_000 }), 'owned forward cleanup');
        if (!/Remove forward ruler success/i.test(removedForward)) fail('HDC did not explicitly confirm owned forward removal');
        const remainingForwards = clean(hdc(tools.hdc, serial, ['fport', 'ls'], { label: 'owned forward absence check', timeout: 8_000 }));
        if (forwardRule(localPort).test(remainingForwards)) fail('owned video forward is still present after removal');
        forwardRemoved = true;
      } catch { forwardRemoved = false; }
    } else {
      forwardRemoved = true;
    }
    if (installAttempted) {
      try {
        const installedBundles = requiredText(hdc(tools.hdc, serial, ['shell', 'bm', 'dump', '-a'], { label: 'owned package cleanup check', timeout: 15_000 }), 'owned package cleanup check');
        if (installedBundles.includes(MIRROR_BUNDLE)) {
          try { hdc(tools.hdc, serial, ['shell', 'aa', 'force-stop', MIRROR_BUNDLE], { label: 'mirror stop', timeout: 8_000 }); } catch { /* uninstall remains authoritative */ }
          const removed = clean(hdc(tools.hdc, serial, ['uninstall', MIRROR_BUNDLE], { label: 'mirror uninstall', timeout: 30_000 }));
          if (!/success/i.test(removed)) fail('the phone did not confirm mirror uninstall');
          const remainingBundles = requiredText(hdc(tools.hdc, serial, ['shell', 'bm', 'dump', '-a'], { label: 'package absence check', timeout: 15_000 }), 'package absence check');
          packageAbsent = !remainingBundles.includes(MIRROR_BUNDLE);
        } else {
          packageAbsent = true;
        }
      } catch {
        packageAbsent = false;
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
  if (operationError) throw operationError;
  if (!evidence || !forwardRemoved || !packageAbsent) fail('owned device cleanup or media evidence is incomplete');
  return await attachDeviceAcceptance(resourcesDirectory, origin, {
    passed: true,
    acceptedAt: new Date().toISOString(),
    serialSha256: hash(Buffer.from(serial, 'utf8')),
    installVerified: true,
    launchVerified: true,
    consentVerified: true,
    video: evidence.video,
    screenshot: evidence.screenshot,
    cleanup: { forwardRemoved, packageAbsent },
  });
}

async function jsonFileForDevice(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { fail(`cannot read ${path}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [resourcesDirectory, serialArgument, ...extra] = process.argv.slice(2);
  const serial = serialArgument === '--serial' ? extra.shift() : undefined;
  if (!resourcesDirectory || !serial || extra.length) throw new Error('Usage: node scripts/verify-harmony-mirror-device.mjs <resource-directory> --serial <serial>');
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await verifyHarmonyMirrorOnDevice({ projectRoot, resourcesDirectory: resolve(resourcesDirectory), serial });
  console.log('Real phone accepted the signed HAP and produced native video plus a fresh screenshot; owned resources were removed.');
}
