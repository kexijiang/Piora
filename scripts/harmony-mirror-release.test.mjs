import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attachDeviceAcceptance,
  buildHarmonyMirrorRelease,
  createHarmonyMirrorSourceNote,
  extractHarmonyUdids,
  freezeRegularFile,
  isDevEcoProtectedPassword,
  MIRROR_HAP_FILE,
  MIRROR_SIGNATURE_FILE,
  MIRROR_SOURCE_FILE,
  readAndVerifySignatureReceipt,
  readAndVerifySourceNote,
  verifyFrozenRegularFile,
} from './harmony-mirror-release.mjs';
import { ARTIFACT_FILE } from './harmony-mirror-provenance.mjs';

const origin = { repository: 'example/Piora', commit: 'a'.repeat(40), runId: '42', runAttempt: '1',
  workflowRef: 'example/Piora/.github/workflows/harmony-preview.yml@refs/tags/v0.5.5-beta.2' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = Array(32).fill('AA').join(':');

async function receiptFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'piora-mirror-signature-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicHap = Buffer.from('public unsigned release HAP fixture');
  const acceptanceHap = Buffer.from('separate private signed acceptance HAP fixture');
  await writeFile(join(directory, MIRROR_HAP_FILE), publicHap);
  const validFrom = '2021-02-02T12:19:31.000Z';
  const validTo = '2049-12-31T12:19:31.000Z';
  const receipt = {
    schemaVersion: 2,
    kind: 'private-device-acceptance-verification',
    origin,
    artifact: { filename: MIRROR_HAP_FILE, size: publicHap.length, sha256: hash(publicHap) },
    acceptanceArtifact: { size: acceptanceHap.length, sha256: hash(acceptanceHap), sourceSha256: hash(publicHap) },
    sdk: { apiVersion: '26', platformVersion: '26.0.0', toolVersion: '26.0.0.23', releaseType: 'Beta1', signToolSha256: 'b'.repeat(64) },
    signing: { mode: 'localSign', material: 'private DevEco acceptance identity', alias: 'debugKey',
      profileType: 'debug', compatibleVersion: 26, signCode: true, distribution: 'public artifact remains unsigned' },
    verification: {
      verifyApp: true,
      verifyProfile: true,
      certificate: { issuer: 'Huawei CBG Developer Relations CA G2', trustRoot: 'Huawei CBG Root CA G2',
        sha256Fingerprint: fingerprint, validFrom, validTo,
        currentlyValid: true, chainLength: 3, chainSha256: 'c'.repeat(64) },
      profile: { type: 'debug', issuer: 'app_gallery', bundleName: 'com.ohos.scrcpy.server',
        apl: 'normal', appFeature: 'hos_normal_app', notBefore: Date.parse(validFrom) / 1000, notAfter: Date.parse(validTo) / 1000,
        aclCount: 0, restrictedPermissionCount: 0, developerIdSha256: 'f'.repeat(64),
        deviceIdType: 'udid', deviceCount: 2, boundDeviceSha256: 'd'.repeat(64) },
    },
    deviceAcceptance: null,
  };
  const manifest = {
    origin,
    sourceTreeSha256: 'f'.repeat(64),
    artifact: {
      ...receipt.artifact,
      component: { bundleName: 'com.ohos.scrcpy.server', versionName: '1.1.27', versionCode: 1_000_127 },
    },
  };
  await writeFile(join(directory, MIRROR_SIGNATURE_FILE), JSON.stringify(receipt));
  await writeFile(join(directory, ARTIFACT_FILE), JSON.stringify(manifest));
  return { directory, receipt, manifest, publicHap, acceptanceHap };
}

function deviceAcceptance(receipt, update = {}) {
  return {
    passed: true,
    acceptedAt: '2026-10-05T00:00:00.000Z',
    serialSha256: 'a'.repeat(64),
    udidSha256: receipt.verification.profile.boundDeviceSha256,
    acceptedHapSha256: receipt.acceptanceArtifact.sha256,
    installVerified: true,
    launchVerified: true,
    consentVerified: true,
    video: { codec: 'h264', width: 1080, height: 2412, fps: 30, configurationPackets: 1, frames: 15, keyframes: 1, bytes: 1024 },
    screenshot: { png: true, size: 1024, sha256: 'e'.repeat(64), width: 1080, height: 2400 },
    cleanup: { forwardRemoved: true, packageAbsent: true },
    ...update,
  };
}

test('DevEco protected-password and UDID parsing accept only bounded opaque values', () => {
  const protectedPassword = Buffer.alloc(33);
  protectedPassword.writeUInt32BE(17, 0);
  assert.equal(isDevEcoProtectedPassword(protectedPassword.toString('hex')), true);
  for (const value of ['', 'plain-text-password', '00'.repeat(32), `0${protectedPassword.toString('hex')}`]) {
    assert.equal(isDevEcoProtectedPassword(value), false);
  }
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  assert.deepEqual(extractHarmonyUdids(`prefix ${first} ${first} ${second} suffix`), [first, second]);
  assert.deepEqual(extractHarmonyUdids(`0${first}f ${first.slice(1)} ${second}0`), []);
});

test('device-bound signing is fail closed for stable tags until an AGC release identity exists', async () => {
  await assert.rejects(buildHarmonyMirrorRelease({
    projectRoot: process.cwd(),
    workspace: join(tmpdir(), 'unused-harmony-workspace'),
    outputDirectory: join(tmpdir(), 'unused-harmony-output'),
    environment: { GITHUB_REF_NAME: 'v1.2.3' },
  }), /preview-only; stable releases require an AGC release certificate and profile/);
});

test('exclusive release snapshots retain one measured byte sequence and reject later mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piora-mirror-freeze-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.hap');
  const frozen = join(directory, 'frozen.hap');
  const original = Buffer.from('receipt-bound unsigned bytes');
  await writeFile(source, original);
  const snapshot = await freezeRegularFile(source, frozen);
  assert.deepEqual(snapshot, { size: original.length, sha256: hash(original) });

  await writeFile(source, 'changed source after freeze');
  assert.deepEqual(await readFile(frozen), original);
  assert.deepEqual(await verifyFrozenRegularFile(frozen, snapshot), snapshot);
  await assert.rejects(freezeRegularFile(source, frozen), error => error.code === 'EEXIST');

  await writeFile(frozen, 'mutated frozen bytes');
  await assert.rejects(verifyFrozenRegularFile(frozen, snapshot), /changed after measurement/);
});

test('signature receipt binds separate public and private bytes and remains fail closed before device acceptance', async t => {
  const fixture = await receiptFixture(t);
  assert.deepEqual(await readAndVerifySignatureReceipt(fixture.directory, origin), fixture.receipt);
  assert.equal(fixture.receipt.acceptanceArtifact.sourceSha256, fixture.receipt.artifact.sha256);
  assert.notEqual(fixture.receipt.acceptanceArtifact.sha256, fixture.receipt.artifact.sha256);
  await assert.rejects(readFile(join(fixture.directory, 'OHScrcpyServer.acceptance.hap')), error => error.code === 'ENOENT');
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
  const changed = Buffer.from('different public unsigned release HAP fixture');
  await writeFile(join(fixture.directory, MIRROR_HAP_FILE), changed);
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin), /does not bind the public unsigned HAP/);
  await writeFile(join(fixture.directory, MIRROR_HAP_FILE), fixture.publicHap);
  fixture.receipt.acceptanceArtifact.sourceSha256 = '9'.repeat(64);
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(fixture.receipt));
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin), /separate private acceptance HAP/);
});

test('hardware acceptance binds the profile UDID and private HAP, then requires complete evidence', async t => {
  const fixture = await receiptFixture(t);
  const acceptance = deviceAcceptance(fixture.receipt);
  await assert.rejects(attachDeviceAcceptance(fixture.directory, origin, {
    ...acceptance, udidSha256: 'a'.repeat(64),
  }), /does not match the DevEco profile binding/);
  await assert.rejects(attachDeviceAcceptance(fixture.directory, origin, {
    ...acceptance, acceptedHapSha256: 'b'.repeat(64),
  }), /does not match the private signed HAP/);
  const updated = await attachDeviceAcceptance(fixture.directory, origin, acceptance);
  assert.deepEqual(await readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), updated);
  updated.deviceAcceptance.video.frames = 9;
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(updated));
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
  updated.deviceAcceptance.video.frames = 15;
  updated.deviceAcceptance.screenshot.sha256 = 'not-a-hash';
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(updated));
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
});

test('generated SOURCE note binds the same run and rejects stale legacy text', async t => {
  const fixture = await receiptFixture(t);
  fixture.receipt.deviceAcceptance = deviceAcceptance(fixture.receipt);
  const note = createHarmonyMirrorSourceNote(fixture.manifest, fixture.receipt);
  assert.match(note, new RegExp(origin.commit));
  assert.match(note, new RegExp(fixture.receipt.artifact.sha256));
  assert.match(note, new RegExp(fixture.receipt.acceptanceArtifact.sha256));
  assert.match(note, /public release-mode HAP.*intentionally remains unsigned/);
  assert.match(note, /separate private DevEco-signed copy/);
  assert.match(note, /never staged or uploaded/);
  assert.match(note, /H\.264 video evidence: `1080x2412@30`.*15` frame\(s\).*1` IDR frame\(s\)/);
  assert.match(note, /1080x2400/);
  assert.doesNotMatch(note, /1\.0\.3|A65A99F1222F8FC13C8D7AD33D01390A00FFD227A438840231F3860C69EDD0C7/i);
  await writeFile(join(fixture.directory, MIRROR_SOURCE_FILE), note);
  assert.equal(await readAndVerifySourceNote(fixture.directory, fixture.manifest, fixture.receipt), note);
  await writeFile(join(fixture.directory, MIRROR_SOURCE_FILE), `${note}\nLegacy 1.0.3 resource`);
  await assert.rejects(readAndVerifySourceNote(fixture.directory, fixture.manifest, fixture.receipt), /SOURCE\.md is stale/);
});

test('tag workflows upload only the accepted public unsigned HAP while private signing stays ephemeral', async () => {
  const preview = await readFile(new URL('../.github/workflows/harmony-preview.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const publish = await readFile(new URL('../.github/workflows/publish-preview.yml', import.meta.url), 'utf8');
  for (const workflow of [preview, release]) {
    assert.match(workflow, /runs-on: \[self-hosted, Windows, harmony-device, harmony-api26, ephemeral\]/);
    assert.match(workflow, /build-harmony-mirror-release\.mjs/);
    assert.match(workflow, /PIORA_HARMONY_SIGNING_CONFIG_PATH is required on the dedicated runner/);
    assert.match(workflow, /HARMONY_SERIAL: \$\{\{ secrets\.HARMONY_DEVICE_SERIAL \}\}/);
    assert.match(workflow, /\.private-acceptance\/OHScrcpyServer\.acceptance\.hap/);
    assert.match(workflow, /verify-harmony-mirror-device\.mjs \$resources --accepted-hap \$acceptedHap --serial \$env:HARMONY_SERIAL/);
    assert.match(workflow, /stage-harmony-mirror-artifact\.mjs/);
    assert.match(workflow, /name: harmony-mirror-resource-\$\{\{ github\.ref_name \}\}/);
    assert.match(workflow, /harmony-mirror-signature-verification\.json/);
    assert.match(workflow, /PIORA_REQUIRE_HARMONY_RELEASE_RESOURCE: '1'/);
    assert.match(workflow, /name: Remove private signing and acceptance files\s+if: always\(\)/);
    const upload = workflow.match(/name: Upload accepted Harmony mirror resource[\s\S]*?if-no-files-found: error/)?.[0] ?? '';
    assert.match(upload, /OHScrcpyServer\.hap/);
    assert.match(upload, /harmony-mirror-manifest\.json/);
    assert.match(upload, /harmony-mirror-signature-verification\.json/);
    assert.match(upload, /SOURCE\.md/);
    assert.doesNotMatch(upload, /acceptance\.hap|\.private-acceptance|\.signing|\.ohos/i);
  }
  const beforeBuild = await readFile(new URL('./electron-before-build.cjs', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('./verify-harmony-mirror-artifact.mjs', import.meta.url), 'utf8');
  const deviceGate = await readFile(new URL('./verify-harmony-mirror-device.mjs', import.meta.url), 'utf8');
  const releaseModule = await readFile(new URL('./harmony-mirror-release.mjs', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
  assert.match(beforeBuild, /PIORA_REQUIRE_HARMONY_RELEASE_RESOURCE === "1"/);
  assert.match(beforeBuild, /verifyStagedHarmonyMirrorRelease/);
  assert.match(verifier, /verifyStagedHarmonyMirrorRelease/);
  assert.match(deviceGate, /pre-install package absence check/);
  assert.match(deviceGate, /'bm', 'get', '--udid'/);
  assert.match(deviceGate, /freezeRegularFile\(acceptedHap, frozenAcceptedHap\)/);
  assert.match(deviceGate, /\['install', frozenAcceptedHap\]/);
  assert.ok((deviceGate.match(/verifyFrozenRegularFile\(frozenAcceptedHap, frozenAccepted\)/g) ?? []).length >= 2);
  assert.match(deviceGate, /await rm\(temporary, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(deviceGate, /\['install', '-r'/);
  assert.match(releaseModule, /inputPath: frozenUnsignedHap/);
  assert.match(releaseModule, /freezeRegularFile\(signerOutput, signedHap\)/);
  assert.match(releaseModule, /copyFile\(frozenUnsignedHap, publicHapPath, 1\)/);
  assert.match(releaseModule, /acceptanceArtifact: \{ \.\.\.frozenAcceptance, sourceSha256: frozenUnsigned\.sha256 \}/);
  assert.match(releaseModule, /if \(!retainPrivateAcceptance\) await rm\(privateDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(builder, /- "harmony-mirror-signature-verification\.json"/);
  assert.match(builder, /from: \.\.\/lib\/harmony\/runtime\/PioraHapSigner\.java/);
  assert.doesNotMatch(builder, /OHScrcpyServer\.acceptance\.hap|\.private-acceptance/);
  assert.doesNotMatch(preview, /gh release create/);
  assert.match(preview, /needs: harmony-mirror/);
  assert.match(release, /needs: \[source-gate, harmony-mirror\]/);
  assert.match(publish, /workflow_dispatch:/);
  assert.match(publish, /environment: preview-publish/);
  assert.match(publish, /run-id: \$\{\{ inputs\.build_run_id \}\}/);
  assert.match(publish, /run\.path -ne '\.github\/workflows\/harmony-preview\.yml'/);
  assert.match(publish, /run\.head_branch -ne \$env:PREVIEW_TAG/);
  assert.match(publish, /gh release create/);
});
