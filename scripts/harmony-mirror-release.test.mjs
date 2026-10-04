import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createApplicationCertificateArguments,
  createHarmonyMirrorSourceNote,
  createOrdinaryReleaseProfile,
  MIRROR_HAP_FILE,
  MIRROR_SIGNATURE_FILE,
  MIRROR_SOURCE_FILE,
  readAndVerifySignatureReceipt,
  readAndVerifySourceNote,
} from './harmony-mirror-release.mjs';

const origin = { repository: 'example/Piora', commit: 'a'.repeat(40), runId: '42', runAttempt: '1',
  workflowRef: 'example/Piora/.github/workflows/harmony-preview.yml@refs/tags/v0.5.5-beta.2' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = Array(32).fill('AA').join(':');

async function receiptFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'piora-mirror-signature-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hap = Buffer.from('signed release HAP fixture');
  await writeFile(join(directory, MIRROR_HAP_FILE), hap);
  const receipt = {
    schemaVersion: 1,
    kind: 'ordinary-mirror-signature-verification',
    origin,
    artifact: { filename: MIRROR_HAP_FILE, size: hap.length, sha256: hash(hap) },
    sdk: { apiVersion: '26', platformVersion: '26.0.0', toolVersion: '26.0.0.23', releaseType: 'Beta1', signToolSha256: 'b'.repeat(64) },
    signing: { mode: 'localSign', material: 'OpenHarmony SDK release example', alias: 'openharmony application release',
      profileAlias: 'openharmony application profile release', compatibleVersion: 26, signCode: true },
    verification: {
      verifyApp: true,
      verifyProfile: true,
      certificate: { subject: 'CN=OpenHarmony Application Release', issuer: 'CN=OpenHarmony Application CA',
        sha256Fingerprint: fingerprint, validFrom: '2021-02-02T12:19:31.000Z', validTo: '2049-12-31T12:19:31.000Z',
        currentlyValid: true, chainLength: 3, chainSha256: 'c'.repeat(64) },
      profile: { type: 'release', distributionType: 'os_integration', bundleName: 'com.ohos.scrcpy.server',
        apl: 'normal', appFeature: 'hos_normal_app', notBefore: 1, notAfter: 4_102_444_800,
        aclCount: 0, restrictedPermissionCount: 0 },
    },
    deviceAcceptance: null,
  };
  await writeFile(join(directory, MIRROR_SIGNATURE_FILE), JSON.stringify(receipt));
  return { directory, receipt };
}

test('generated OpenHarmony release profile stays ordinary and currently valid', () => {
  const now = Date.UTC(2026, 9, 5);
  const profile = createOrdinaryReleaseProfile({
    distributionCertificate: '-----BEGIN CERTIFICATE-----\r\npublic certificate fixture\r\n-----END CERTIFICATE-----', now,
    uuid: '00000000-0000-4000-8000-000000000001' });
  assert.equal(profile.type, 'release');
  assert.equal(profile['app-distribution-type'], 'os_integration');
  assert.deepEqual(profile.acls['allowed-acls'], []);
  assert.deepEqual(profile.permissions['restricted-permissions'], []);
  assert.equal(profile['app-privilege-capabilities'], undefined);
  assert.deepEqual(profile['bundle-info'], {
    'developer-id': 'OpenHarmony',
    'distribution-certificate': '-----BEGIN CERTIFICATE-----\npublic certificate fixture\n-----END CERTIFICATE-----\n',
    'bundle-name': 'com.ohos.scrcpy.server',
    apl: 'normal',
    'app-feature': 'hos_normal_app',
  });
  assert.ok(profile.validity['not-before'] * 1000 <= now);
  assert.ok(profile.validity['not-after'] * 1000 > now);
});

test('profile certificate keeps the API 26 PEM line-ending contract', () => {
  const certificate = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';
  const profile = createOrdinaryReleaseProfile({ distributionCertificate: certificate });
  assert.equal(profile['bundle-info']['distribution-certificate'], `${certificate}\n`);
  assert.equal(createOrdinaryReleaseProfile({ distributionCertificate: `${certificate}\n\n` })
    ['bundle-info']['distribution-certificate'], `${certificate}\n`);
});

test('application signing generates the required SDK CA chain instead of reusing the one-certificate template leaf', () => {
  const args = createApplicationCertificateArguments({
    signTool: 'hap-sign-tool.jar',
    keyStore: 'OpenHarmony.p12',
    rootCertificate: 'rootCA.cer',
    subCertificate: 'subCA.cer',
    outputCertificate: 'application-release.cer',
  });
  assert.deepEqual(args.slice(0, 3), ['-jar', 'hap-sign-tool.jar', 'generate-app-cert']);
  assert.equal(args[args.indexOf('-keyAlias') + 1], 'openharmony application release');
  assert.equal(args[args.indexOf('-issuerKeyAlias') + 1], 'openharmony application ca');
  assert.equal(args[args.indexOf('-rootCaCertFile') + 1], 'rootCA.cer');
  assert.equal(args[args.indexOf('-subCaCertFile') + 1], 'subCA.cer');
  assert.equal(args[args.indexOf('-outForm') + 1], 'certChain');
  assert.equal(args[args.indexOf('-outFile') + 1], 'application-release.cer');
});

test('signature receipt binds exact bytes and remains fail closed before device acceptance', async t => {
  const fixture = await receiptFixture(t);
  assert.deepEqual(await readAndVerifySignatureReceipt(fixture.directory, origin), fixture.receipt);
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
  const changed = Buffer.from('different signed release HAP fixture');
  await writeFile(join(fixture.directory, MIRROR_HAP_FILE), changed);
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin), /does not bind/);
});

test('hardware acceptance receipt requires install, launch, video, screenshot and cleanup evidence', async t => {
  const fixture = await receiptFixture(t);
  fixture.receipt.deviceAcceptance = {
    passed: true,
    acceptedAt: '2026-10-05T00:00:00.000Z',
    serialSha256: 'd'.repeat(64),
    installVerified: true,
    launchVerified: true,
    consentVerified: true,
    video: { codec: 'h264', width: 1080, height: 2412, fps: 30, configurationPackets: 1, frames: 15, keyframes: 1, bytes: 1024 },
    screenshot: { png: true, size: 1024, sha256: 'e'.repeat(64), width: 1080, height: 2400 },
    cleanup: { forwardRemoved: true, packageAbsent: true },
  };
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(fixture.receipt));
  assert.deepEqual(await readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), fixture.receipt);
  fixture.receipt.deviceAcceptance.video.frames = 9;
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(fixture.receipt));
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
  fixture.receipt.deviceAcceptance.video.frames = 15;
  fixture.receipt.deviceAcceptance.screenshot.sha256 = 'not-a-hash';
  await writeFile(join(fixture.directory, MIRROR_SIGNATURE_FILE), JSON.stringify(fixture.receipt));
  await assert.rejects(readAndVerifySignatureReceipt(fixture.directory, origin, { requireDevice: true }), /real-device acceptance/);
});

test('generated SOURCE note binds the same run and rejects stale legacy text', async t => {
  const fixture = await receiptFixture(t);
  fixture.receipt.deviceAcceptance = {
    passed: true,
    acceptedAt: '2026-10-05T00:00:00.000Z',
    serialSha256: 'd'.repeat(64),
    installVerified: true,
    launchVerified: true,
    consentVerified: true,
    video: { codec: 'h264', width: 1080, height: 2412, fps: 30, configurationPackets: 1, frames: 15, keyframes: 1, bytes: 1024 },
    screenshot: { png: true, size: 1024, sha256: 'e'.repeat(64), width: 1080, height: 2400 },
    cleanup: { forwardRemoved: true, packageAbsent: true },
  };
  const manifest = {
    origin,
    sourceTreeSha256: 'f'.repeat(64),
    artifact: {
      ...fixture.receipt.artifact,
      component: { bundleName: 'com.ohos.scrcpy.server', versionName: '1.1.27', versionCode: 1_000_127 },
    },
  };
  const note = createHarmonyMirrorSourceNote(manifest, fixture.receipt);
  assert.match(note, new RegExp(origin.commit));
  assert.match(note, new RegExp(fixture.receipt.artifact.sha256));
  assert.match(note, /H\.264 video evidence: `1080x2412@30`.*15` frame\(s\).*1` IDR frame\(s\)/);
  assert.match(note, /1080x2400/);
  assert.doesNotMatch(note, /1\.0\.3|A65A99F1222F8FC13C8D7AD33D01390A00FFD227A438840231F3860C69EDD0C7/i);
  await writeFile(join(fixture.directory, MIRROR_SOURCE_FILE), note);
  assert.equal(await readAndVerifySourceNote(fixture.directory, manifest, fixture.receipt), note);
  await writeFile(join(fixture.directory, MIRROR_SOURCE_FILE), `${note}\nLegacy 1.0.3 resource`);
  await assert.rejects(readAndVerifySourceNote(fixture.directory, manifest, fixture.receipt), /SOURCE\.md is stale/);
});

test('tag workflows pass one accepted HAP artifact to desktop packaging and beta publishing is separately gated', async () => {
  const preview = await readFile(new URL('../.github/workflows/harmony-preview.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const publish = await readFile(new URL('../.github/workflows/publish-preview.yml', import.meta.url), 'utf8');
  for (const workflow of [preview, release]) {
    assert.match(workflow, /runs-on: \[self-hosted, Windows, harmony-device, harmony-api26, ephemeral\]/);
    assert.match(workflow, /build-harmony-mirror-release\.mjs/);
    assert.match(workflow, /verify-harmony-mirror-device\.mjs/);
    assert.match(workflow, /stage-harmony-mirror-artifact\.mjs/);
    assert.match(workflow, /name: harmony-mirror-resource-\$\{\{ github\.ref_name \}\}/);
    assert.match(workflow, /harmony-mirror-signature-verification\.json/);
    assert.match(workflow, /PIORA_REQUIRE_HARMONY_RELEASE_RESOURCE: '1'/);
  }
  const beforeBuild = await readFile(new URL('./electron-before-build.cjs', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('./verify-harmony-mirror-artifact.mjs', import.meta.url), 'utf8');
  const deviceGate = await readFile(new URL('./verify-harmony-mirror-device.mjs', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
  assert.match(beforeBuild, /PIORA_REQUIRE_HARMONY_RELEASE_RESOURCE === "1"/);
  assert.match(beforeBuild, /verifyStagedHarmonyMirrorRelease/);
  assert.match(verifier, /verifyStagedHarmonyMirrorRelease/);
  assert.match(deviceGate, /pre-install package absence check/);
  assert.doesNotMatch(deviceGate, /\['install', '-r'/);
  assert.match(builder, /- "harmony-mirror-signature-verification\.json"/);
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
