import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  validateH264Configuration,
  validateH264Frame,
  verifyHarmonyMirrorOnDevice,
} from './verify-harmony-mirror-device.mjs';

const verifierSource = await readFile(new URL('./verify-harmony-mirror-device.mjs', import.meta.url), 'utf8');

function config(codec = 0, sps = Buffer.from([0x67, 0x42, 0x00, 0x1f]), pps = Buffer.from([0x68, 0xce, 0x06, 0xe2])) {
  const payload = Buffer.alloc(17 + sps.length + pps.length);
  payload[0] = codec;
  payload.writeUInt32BE(1080, 1);
  payload.writeUInt32BE(2412, 5);
  payload.writeUInt32BE(30, 9);
  payload.writeUInt16BE(sps.length, 13);
  sps.copy(payload, 15);
  payload.writeUInt16BE(pps.length, 15 + sps.length);
  pps.copy(payload, 17 + sps.length);
  return payload;
}

function frame({ key = false, timestamp = 1n, nal = key ? 0x65 : 0x41 } = {}) {
  const payload = Buffer.alloc(14);
  payload[0] = key ? 1 : 0;
  payload.writeBigUInt64BE(timestamp, 1);
  payload.set([0, 0, 0, 1, nal], 9);
  return payload;
}

test('real-device evidence accepts a bounded H.264 SPS/PPS config and IDR sequence', () => {
  const parsed = validateH264Configuration(config());
  assert.deepEqual({ width: parsed.width, height: parsed.height, fps: parsed.fps }, { width: 1080, height: 2412, fps: 30 });
  const first = validateH264Frame(frame({ key: true, timestamp: 10n }), undefined, true);
  assert.equal(first.keyframe, true);
  assert.equal(validateH264Frame(frame({ timestamp: 11n }), first.timestamp).keyframe, false);
});

test('RAW or JPEG fallback config cannot satisfy the H.264 phone gate', () => {
  assert.throws(() => validateH264Configuration(config(1)), /did not negotiate H\.264/);
  assert.throws(() => validateH264Configuration(config(2)), /did not negotiate H\.264/);
});

test('malformed parameter sets and non-IDR key flags fail closed', () => {
  assert.throws(() => validateH264Configuration(config(0, Buffer.from([0x65, 1, 2, 3]))), /one SPS and one PPS/);
  assert.throws(() => validateH264Frame(frame({ key: true, nal: 0x41 }), undefined, true), /key flag or slice type/);
  assert.throws(() => validateH264Frame(frame({ key: false, nal: 0x65 })), /key flag or slice type/);
});

test('acceptance requires a first IDR and strictly increasing timestamps', () => {
  assert.throws(() => validateH264Frame(frame({ timestamp: 10n }), undefined, true), /key flag or slice type/);
  assert.throws(() => validateH264Frame(frame({ timestamp: 10n }), 10n), /strictly increasing/);
});

test('device verification requires an explicit absolute private acceptance HAP', async () => {
  await assert.rejects(verifyHarmonyMirrorOnDevice({
    projectRoot: process.cwd(),
    resourcesDirectory: process.cwd(),
    acceptedHapPath: 'relative-acceptance.hap',
    serial: 'fixture-serial',
    environment: {},
  }), /absolute private acceptance HAP path is required/);
  await assert.rejects(verifyHarmonyMirrorOnDevice({
    projectRoot: process.cwd(),
    resourcesDirectory: process.cwd(),
    acceptedHapPath: join(tmpdir(), 'private-acceptance.hap'),
    serial: 'contains whitespace',
    environment: {},
  }), /valid dedicated HDC serial is required/);
});

test('device verification installs and records only the receipt-bound private copy', () => {
  assert.match(verifierSource, /verifyFrozenRegularFile\(acceptedHap, acceptedHapExpected\)/);
  assert.match(verifierSource, /freezeRegularFile\(acceptedHap, frozenAcceptedHap\)/);
  assert.ok((verifierSource.match(/verifyFrozenRegularFile\(frozenAcceptedHap, frozenAccepted\)/g) ?? []).length >= 2);
  assert.match(verifierSource, /\['install', frozenAcceptedHap\]/);
  assert.doesNotMatch(verifierSource, /\['install', acceptedHap\]/);
  assert.doesNotMatch(verifierSource, /\['install', '-r'/);
  assert.match(verifierSource, /acceptedHapSha256: frozenAccepted\.sha256/);
  assert.match(verifierSource, /udidSha256: hash\(Buffer\.from\(acceptedDeviceUdid\.toLocaleLowerCase\(\), 'utf8'\)\)/);
  assert.match(verifierSource, /--accepted-hap <private-signed-hap> --serial <serial>/);
});
