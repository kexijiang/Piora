import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { decryptDevEcoProtectedPassword, signHapWithJava } from '../lib/harmony/runtime/deveco-password.mjs';

import {
  ARTIFACT_FILE,
  readGitHubBuildOrigin,
  recordHarmonyMirrorArtifact,
  verifyHarmonyMirrorArtifact,
} from './harmony-mirror-provenance.mjs';
import { prepareHarmonyMirror } from './prepare-harmony-mirror.mjs';

export const MIRROR_HAP_FILE = 'OHScrcpyServer.hap';
export const MIRROR_SIGNATURE_FILE = 'harmony-mirror-signature-verification.json';
export const MIRROR_SOURCE_FILE = 'SOURCE.md';
export const MIRROR_BUNDLE = 'com.ohos.scrcpy.server';
const DEVICE_SIGNING_DESCRIPTOR_ENV = 'PIORA_HARMONY_SIGNING_CONFIG_PATH';
const DEVICE_SIGNING_NAME = 'pioraHarmonyDevice';
const DEVICE_SIGNING_ALIAS = 'debugKey';
const DEVICE_SIGNING_ALGORITHM = 'SHA256withECDSA';
const HUAWEI_DEVELOPER_CA = 'CN=Huawei CBG Developer Relations CA G2';
const HUAWEI_ROOT_CA = 'CN=Huawei CBG Root CA G2';
const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Harmony mirror release: ${message}`); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const boundedInteger = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

async function regularFile(path, maximum = 256 * 1024 * 1024) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximum) fail(`missing or invalid ${basename(path)}`);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail(`${basename(path)} changed while being measured`);
  return bytes;
}

export async function freezeRegularFile(source, target, maximum = 256 * 1024 * 1024) {
  let sourceBytes;
  let frozenBytes;
  try {
    sourceBytes = await regularFile(source, maximum);
    await writeFile(target, sourceBytes, { flag: 'wx', mode: 0o600 });
    frozenBytes = await regularFile(target, maximum);
    if (!sourceBytes.equals(frozenBytes)) fail(`frozen ${basename(target)} differs from its measured input`);
    return { size: frozenBytes.length, sha256: hash(frozenBytes) };
  } finally {
    sourceBytes?.fill(0);
    frozenBytes?.fill(0);
  }
}

export async function verifyFrozenRegularFile(path, expected, maximum = 256 * 1024 * 1024) {
  let bytes;
  try {
    bytes = await regularFile(path, maximum);
    const actual = { size: bytes.length, sha256: hash(bytes) };
    if (!expected || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      fail(`frozen ${basename(path)} changed after measurement`);
    }
    return actual;
  } finally {
    bytes?.fill(0);
  }
}

async function replaceRegularFile(source, target) {
  await regularFile(source);
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) fail(`refusing to replace nonregular ${basename(target)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyFile(source, target);
  await regularFile(target);
}

async function jsonFile(path, maximum = 4 * 1024 * 1024) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await regularFile(path, maximum))); }
  catch (error) { fail(`cannot read ${basename(path)} (${error.code ?? 'invalid JSON'})`); }
}

function runTool(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: MAX_TOOL_OUTPUT,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0) {
    let detail = output.slice(-8_000)
      .replace(/(-keystorePwd|-keyPwd)\s+\S+/gi, '$1 <redacted>');
    if (options.sensitiveOutput) detail = detail.replace(/[A-Za-z0-9_+/=-]{24,}/g, '<redacted>');
    for (const secret of options.redact ?? []) {
      if (typeof secret === 'string' && secret.length >= 8) detail = detail.replaceAll(secret, '<redacted>');
    }
    fail(`${label} failed${result.status === null ? '' : ` with exit ${result.status}`}${detail ? `\n${detail}` : ''}`);
  }
  return output;
}

export function isDevEcoProtectedPassword(value) {
  if (typeof value !== 'string' || value.length < 66 || value.length > 544
    || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return false;
  const bytes = Buffer.from(value, 'hex');
  if (bytes.length < 33) return false;
  const encryptedLength = bytes.readUInt32BE(0);
  return encryptedLength >= 17 && encryptedLength <= 272 && bytes.length - 4 - encryptedLength === 12;
}

export function extractHarmonyUdids(output) {
  return [...new Set(String(output).match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? [])];
}

function pathFromEnvironment(environment, name) {
  const value = environment[name];
  return typeof value === 'string' && value.trim() ? resolve(value.trim()) : undefined;
}

/** Resolve only the checked runner's installed tools; no SDK or signing bytes are downloaded. */
export async function resolveHarmonyReleaseTools(environment = process.env) {
  if (process.platform !== 'win32' && environment.PIORA_HARMONY_ALLOW_NON_WINDOWS_TEST !== '1') fail('the official release toolchain requires the dedicated Windows runner');
  const sdkRoot = pathFromEnvironment(environment, 'DEVECO_SDK_HOME');
  if (!sdkRoot) fail('DEVECO_SDK_HOME must point to the SDK root containing the default directory');
  const studioRoot = pathFromEnvironment(environment, 'DEVECO_STUDIO_HOME') ?? dirname(sdkRoot);
  const sdkDefault = join(sdkRoot, 'default');
  const toolchains = join(sdkDefault, 'openharmony', 'toolchains');
  const library = join(toolchains, 'lib');
  const tools = {
    sdkRoot,
    sdkDefault,
    node: pathFromEnvironment(environment, 'HARMONY_NODE_PATH') ?? join(studioRoot, 'tools', 'node', 'node.exe'),
    java: pathFromEnvironment(environment, 'HARMONY_JAVA_PATH') ?? join(studioRoot, 'jbr', 'bin', 'java.exe'),
    hvigor: pathFromEnvironment(environment, 'HARMONY_HVIGOR_PATH') ?? join(studioRoot, 'tools', 'hvigor', 'bin', 'hvigorw.js'),
    ohpm: pathFromEnvironment(environment, 'HARMONY_OHPM_PATH') ?? join(studioRoot, 'tools', 'ohpm', 'bin', 'pm-cli.js'),
    hdc: pathFromEnvironment(environment, 'HARMONY_HDC_PATH') ?? join(toolchains, 'hdc.exe'),
    signTool: join(library, 'hap-sign-tool.jar'),
    sdkMetadata: join(sdkDefault, 'sdk-pkg.json'),
  };
  for (const [name, path] of Object.entries(tools)) {
    if (name === 'sdkRoot' || name === 'sdkDefault') continue;
    const maximum = name === 'node' ? 256 * 1024 * 1024 : name === 'signTool' ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
    await regularFile(path, maximum);
  }
  const metadata = await jsonFile(tools.sdkMetadata);
  if (metadata.data?.apiVersion !== '26' || metadata.data?.platformVersion !== '26.0.0') fail('runner must provide the reviewed HarmonyOS API 26 SDK');
  return { ...tools, metadata };
}

function releaseEnvironment(tools, environment = process.env) {
  const prepend = [dirname(tools.node), dirname(tools.java), dirname(tools.hdc)];
  return {
    ...environment,
    CI: 'true',
    DEVECO_SDK_HOME: tools.sdkRoot,
    JAVA_HOME: dirname(dirname(tools.java)),
    NODE_HOME: dirname(tools.node),
    PATH: `${prepend.join(';')};${environment.PATH ?? environment.Path ?? ''}`,
  };
}

function pemCertificateBlocks(bytes) {
  return bytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function pemCertificates(bytes) {
  return pemCertificateBlocks(bytes).map(value => new X509Certificate(value));
}

function insideDirectory(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function certificateIsCurrent(certificate, now) {
  return new Date(certificate.validFrom).getTime() <= now && new Date(certificate.validTo).getTime() > now;
}

function validateHuaweiDeveloperChain(certificates, now = Date.now()) {
  const leaves = certificates.filter(certificate => !certificate.ca && certificate.issuer.includes(HUAWEI_DEVELOPER_CA));
  const intermediates = certificates.filter(certificate => certificate.ca && certificate.subject.includes(HUAWEI_DEVELOPER_CA));
  const roots = certificates.filter(certificate => certificate.ca && certificate.subject.includes(HUAWEI_ROOT_CA)
    && certificate.issuer === certificate.subject);
  const [leaf] = leaves;
  const [intermediate] = intermediates;
  const [root] = roots;
  if (certificates.length !== 3 || leaves.length !== 1 || intermediates.length !== 1 || roots.length !== 1
    || leaf.issuer !== intermediate.subject || intermediate.issuer !== root.subject
    || !leaf.verify(intermediate.publicKey) || !intermediate.verify(root.publicKey) || !root.verify(root.publicKey)
    || !certificates.every(certificate => certificateIsCurrent(certificate, now))) {
    fail('DevEco application certificate is not a current Huawei developer certificate chain');
  }
  return { leaf, intermediate, root };
}

export async function loadDeviceSigningConfig(environment = process.env, now = Date.now()) {
  const descriptorPath = pathFromEnvironment(environment, DEVICE_SIGNING_DESCRIPTOR_ENV);
  const userProfile = pathFromEnvironment(environment, 'USERPROFILE');
  if (!descriptorPath || !userProfile) fail(`${DEVICE_SIGNING_DESCRIPTOR_ENV} and USERPROFILE are required on the dedicated runner`);
  const configRoot = await realpath(join(userProfile, '.ohos', 'config'));
  const actualDescriptorPath = await realpath(descriptorPath);
  if (!insideDirectory(configRoot, actualDescriptorPath)) fail('DevEco signing descriptor must stay inside the runner user profile');
  const descriptor = await jsonFile(actualDescriptorPath, 64 * 1024);
  const materialKeys = ['certpath', 'keyAlias', 'keyPassword', 'profile', 'signAlg', 'storeFile', 'storePassword'];
  if (!exactKeys(descriptor, ['schemaVersion', 'name', 'type', 'material']) || descriptor.schemaVersion !== 1
    || descriptor.name !== DEVICE_SIGNING_NAME || descriptor.type !== 'HarmonyOS'
    || !exactKeys(descriptor.material, materialKeys) || descriptor.material.keyAlias !== DEVICE_SIGNING_ALIAS
    || descriptor.material.signAlg !== DEVICE_SIGNING_ALGORITHM) fail('DevEco signing descriptor has an unsupported shape');
  for (const field of ['keyPassword', 'storePassword']) {
    const value = descriptor.material[field];
    if (!isDevEcoProtectedPassword(value)) {
      fail('DevEco signing descriptor contains an invalid protected password');
    }
  }
  const resolvedMaterial = { ...descriptor.material };
  for (const [field, maximum] of [['certpath', 1024 * 1024], ['profile', 2 * 1024 * 1024], ['storeFile', 2 * 1024 * 1024]]) {
    if (typeof descriptor.material[field] !== 'string' || !isAbsolute(descriptor.material[field])) {
      fail(`DevEco signing descriptor ${field} must be absolute`);
    }
    const path = await realpath(descriptor.material[field]);
    if (!insideDirectory(configRoot, path)) fail(`DevEco signing descriptor ${field} leaves the runner user profile`);
    await regularFile(path, maximum);
    resolvedMaterial[field] = path;
  }
  const certificates = pemCertificates(await regularFile(resolvedMaterial.certpath, 1024 * 1024));
  const chain = validateHuaweiDeveloperChain(certificates, now);
  return {
    descriptorPath: actualDescriptorPath,
    signingConfig: { name: descriptor.name, type: descriptor.type, material: resolvedMaterial },
    certificate: chain.leaf,
    secrets: [resolvedMaterial.keyPassword, resolvedMaterial.storePassword],
  };
}

function validateVerifiedProfile(result, expectedCertificate, now = Date.now()) {
  if (result?.verifiedPassed !== true || result.message !== 'OK') fail('official verify-profile did not pass');
  const profile = result.content;
  const info = profile?.['bundle-info'];
  if (profile?.type !== 'debug' || profile?.issuer !== 'app_gallery' || profile?.['app-distribution-type'] !== undefined
    || info?.['bundle-name'] !== MIRROR_BUNDLE || info?.apl !== 'normal' || info?.['app-feature'] !== 'hos_normal_app') {
    fail('verified profile is not the expected ordinary debug identity');
  }
  const acls = profile.acls?.['allowed-acls'];
  if ((acls !== undefined && (!Array.isArray(acls) || acls.length !== 0))
    || (profile.permissions?.['restricted-permissions'] !== undefined
      && (!Array.isArray(profile.permissions['restricted-permissions']) || profile.permissions['restricted-permissions'].length !== 0))
    || profile['app-privilege-capabilities'] !== undefined) fail('verified profile contains privileges or ACLs');
  const debug = profile['debug-info'];
  if (debug?.['device-id-type'] !== 'udid' || !Array.isArray(debug?.['device-ids'])
    || debug['device-ids'].length < 1 || debug['device-ids'].length > 256
    || debug['device-ids'].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value))
    || new Set(debug['device-ids']).size !== debug['device-ids'].length) fail('verified profile has no bounded device allow-list');
  if (!Number.isSafeInteger(profile.validity?.['not-before']) || !Number.isSafeInteger(profile.validity?.['not-after'])
    || profile.validity['not-before'] * 1000 > now || profile.validity['not-after'] * 1000 <= now
    || profile.validity['not-before'] * 1000 < new Date(expectedCertificate.validFrom).getTime()
    || profile.validity['not-after'] * 1000 > new Date(expectedCertificate.validTo).getTime()) {
    fail('verified profile is not currently valid or exceeds its development certificate');
  }
  let embedded;
  try { embedded = new X509Certificate(info['development-certificate']); } catch { fail('verified profile has an invalid development certificate'); }
  if (!embedded.raw.equals(expectedCertificate.raw)) fail('profile development certificate differs from the application signing leaf');
  if (typeof info['developer-id'] !== 'string' || info['developer-id'].length < 1 || info['developer-id'].length > 256) {
    fail('verified profile has no bounded developer identity');
  }
  return profile;
}

export async function readAndVerifySignatureReceipt(resourcesDirectory, expectedOrigin, options = {}) {
  const receipt = await jsonFile(join(resourcesDirectory, MIRROR_SIGNATURE_FILE));
  const expectedKeys = ['schemaVersion', 'kind', 'origin', 'artifact', 'acceptanceArtifact', 'sdk', 'signing', 'verification', 'deviceAcceptance'].sort();
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
    || receipt.schemaVersion !== 2 || receipt.kind !== 'private-device-acceptance-verification'
    || JSON.stringify(receipt.origin) !== JSON.stringify(expectedOrigin)) fail('signature receipt has an unsupported shape or CI identity');
  const hap = await regularFile(join(resourcesDirectory, MIRROR_HAP_FILE));
  if (!exactKeys(receipt.artifact, ['filename', 'size', 'sha256'])
    || receipt.artifact.filename !== MIRROR_HAP_FILE || receipt.artifact.size !== hap.length || receipt.artifact.sha256 !== hash(hap)) fail('signature receipt does not bind the public unsigned HAP');
  if (!exactKeys(receipt.acceptanceArtifact, ['size', 'sha256', 'sourceSha256'])
    || !boundedInteger(receipt.acceptanceArtifact.size, 1, 256 * 1024 * 1024)
    || !/^[0-9a-f]{64}$/.test(receipt.acceptanceArtifact.sha256 ?? '')
    || receipt.acceptanceArtifact.sourceSha256 !== receipt.artifact.sha256
    || receipt.acceptanceArtifact.sha256 === receipt.artifact.sha256) {
    fail('signature receipt does not bind a separate private acceptance HAP to the public unsigned HAP');
  }
  if (!exactKeys(receipt.sdk, ['apiVersion', 'platformVersion', 'toolVersion', 'releaseType', 'signToolSha256'])
    || receipt.sdk.apiVersion !== '26' || receipt.sdk.platformVersion !== '26.0.0'
    || !/^26\.0\.0\.\d+$/.test(receipt.sdk.toolVersion ?? '') || typeof receipt.sdk.releaseType !== 'string'
    || receipt.sdk.releaseType.length < 1 || receipt.sdk.releaseType.length > 32
    || !/^[0-9a-f]{64}$/.test(receipt.sdk.signToolSha256 ?? '')) fail('signature receipt does not identify the reviewed API 26 tool');
  if (!exactKeys(receipt.signing, ['mode', 'material', 'alias', 'profileType', 'compatibleVersion', 'signCode', 'distribution'])
    || receipt.signing.mode !== 'localSign' || receipt.signing.material !== 'private DevEco acceptance identity'
    || receipt.signing.alias !== DEVICE_SIGNING_ALIAS || receipt.signing.profileType !== 'debug'
    || receipt.signing.compatibleVersion !== 26 || receipt.signing.signCode !== true
    || receipt.signing.distribution !== 'public artifact remains unsigned') fail('signature receipt describes an unsupported signing flow');
  const certificate = receipt.verification?.certificate;
  const certificateFrom = typeof certificate?.validFrom === 'string' ? new Date(certificate.validFrom) : new Date(Number.NaN);
  const certificateTo = typeof certificate?.validTo === 'string' ? new Date(certificate.validTo) : new Date(Number.NaN);
  const profile = receipt.verification?.profile;
  const now = Date.now();
  if (!exactKeys(receipt.verification, ['verifyApp', 'verifyProfile', 'certificate', 'profile'])
    || !exactKeys(certificate, ['issuer', 'trustRoot', 'sha256Fingerprint', 'validFrom', 'validTo', 'currentlyValid', 'chainLength', 'chainSha256'])
    || !exactKeys(profile, ['type', 'issuer', 'bundleName', 'apl', 'appFeature', 'notBefore', 'notAfter', 'aclCount',
      'restrictedPermissionCount', 'developerIdSha256', 'deviceIdType', 'deviceCount', 'boundDeviceSha256'])
    || receipt.verification.verifyApp !== true || receipt.verification.verifyProfile !== true
    || profile.type !== 'debug' || profile.issuer !== 'app_gallery'
    || profile.deviceIdType !== 'udid' || !boundedInteger(profile.deviceCount, 1, 256)
    || receipt.verification?.profile?.bundleName !== MIRROR_BUNDLE || receipt.verification?.profile?.apl !== 'normal'
    || receipt.verification?.profile?.appFeature !== 'hos_normal_app' || receipt.verification?.profile?.aclCount !== 0
    || profile.restrictedPermissionCount !== 0 || !boundedInteger(profile.notBefore, 0, 9_007_199_254_740)
    || !boundedInteger(profile.notAfter, profile.notBefore + 1, 9_007_199_254_740)
    || profile.notBefore * 1000 > now || profile.notAfter * 1000 <= now
    || !/^[0-9a-f]{64}$/.test(profile.developerIdSha256 ?? '') || !/^[0-9a-f]{64}$/.test(profile.boundDeviceSha256 ?? '')
    || certificate.currentlyValid !== true || certificate.issuer !== 'Huawei CBG Developer Relations CA G2'
    || certificate.trustRoot !== 'Huawei CBG Root CA G2'
    || !/^[0-9A-F:]{95}$/.test(certificate.sha256Fingerprint ?? '')
    || !/^[0-9a-f]{64}$/.test(certificate.chainSha256 ?? '') || certificate.chainLength !== 3
    || Number.isNaN(certificateFrom.getTime()) || Number.isNaN(certificateTo.getTime())
    || certificateFrom.toISOString() !== certificate.validFrom || certificateTo.toISOString() !== certificate.validTo
    || certificateFrom.getTime() > now || certificateTo.getTime() <= now
    || profile.notBefore * 1000 < certificateFrom.getTime()
    || profile.notAfter * 1000 > certificateTo.getTime()) fail('official signature verification receipt is incomplete');
  if (options.requireDevice) {
    const device = receipt.deviceAcceptance;
    const acceptedAt = typeof device?.acceptedAt === 'string' ? new Date(device.acceptedAt) : new Date(Number.NaN);
    if (!exactKeys(device, ['passed', 'acceptedAt', 'serialSha256', 'udidSha256', 'acceptedHapSha256', 'installVerified', 'launchVerified', 'consentVerified', 'video', 'screenshot', 'cleanup'])
      || !exactKeys(device?.video, ['codec', 'width', 'height', 'fps', 'configurationPackets', 'frames', 'keyframes', 'bytes'])
      || !exactKeys(device?.screenshot, ['png', 'size', 'sha256', 'width', 'height'])
      || !exactKeys(device?.cleanup, ['forwardRemoved', 'packageAbsent'])
      || device?.passed !== true || device.installVerified !== true || device.launchVerified !== true || device.consentVerified !== true
      || Number.isNaN(acceptedAt.getTime()) || acceptedAt.toISOString() !== device.acceptedAt
      || device.video.codec !== 'h264'
      || !boundedInteger(device.video.width, 100, 8192) || !boundedInteger(device.video.height, 100, 8192)
      || !boundedInteger(device.video.fps, 1, 120) || !boundedInteger(device.video.configurationPackets, 1, 10_000)
      || !boundedInteger(device.video.frames, 10, 100_000) || !boundedInteger(device.video.keyframes, 1, device.video.frames)
      || !boundedInteger(device.video.bytes, 1, 1024 * 1024 * 1024)
      || device.screenshot.png !== true || !boundedInteger(device.screenshot.size, 25, 128 * 1024 * 1024)
      || !/^[0-9a-f]{64}$/.test(device.screenshot.sha256 ?? '')
      || !boundedInteger(device.screenshot.width, 100, 32_768) || !boundedInteger(device.screenshot.height, 100, 32_768)
      || device.cleanup.forwardRemoved !== true || device.cleanup.packageAbsent !== true
      || !/^[0-9a-f]{64}$/.test(device.serialSha256 ?? '') || device.udidSha256 !== profile.boundDeviceSha256
      || device.acceptedHapSha256 !== receipt.acceptanceArtifact.sha256) {
      fail('real-device acceptance is missing or incomplete');
    }
  } else if (receipt.deviceAcceptance !== null) fail('pre-device signature receipt must not claim hardware acceptance');
  return receipt;
}

export function createHarmonyMirrorSourceNote(manifest, receipt) {
  const lines = [
    '# Piora Harmony mirror release resource',
    '',
    'This directory was staged by the tagged GitHub Actions run recorded below. The public release-mode HAP was built from `third_party/harmony-mirror` in an isolated workspace and intentionally remains unsigned. The same job created a separate private DevEco-signed copy, verified it with the API 26 SDK, accepted it on the registered HDC phone, and deleted it without uploading or packaging it.',
    '',
    `- Repository: \`${manifest.origin.repository}\``,
    `- Commit: \`${manifest.origin.commit}\``,
    `- Workflow: \`${manifest.origin.workflowRef}\``,
    `- Run: \`${manifest.origin.runId}\` (attempt \`${manifest.origin.runAttempt}\`)`,
    `- Source tree SHA-256: \`${manifest.sourceTreeSha256}\``,
    `- Public unsigned HAP SHA-256: \`${manifest.artifact.sha256}\``,
    `- Public unsigned HAP size: \`${manifest.artifact.size}\` bytes`,
    `- Private acceptance HAP SHA-256: \`${receipt.acceptanceArtifact.sha256}\``,
    `- Component: \`${manifest.artifact.component.bundleName}\` \`${manifest.artifact.component.versionName}\` (\`${manifest.artifact.component.versionCode}\`)`,
    `- SDK: \`${receipt.sdk.toolVersion}\``,
    `- Signing receipt: \`${MIRROR_SIGNATURE_FILE}\``,
    `- Device accepted: \`${receipt.deviceAcceptance.acceptedAt}\``,
    `- Native H.264 video evidence: \`${receipt.deviceAcceptance.video.width}x${receipt.deviceAcceptance.video.height}@${receipt.deviceAcceptance.video.fps}\`, \`${receipt.deviceAcceptance.video.configurationPackets}\` configuration packet(s), \`${receipt.deviceAcceptance.video.frames}\` frame(s), \`${receipt.deviceAcceptance.video.keyframes}\` IDR frame(s), \`${receipt.deviceAcceptance.video.bytes}\` bytes`,
    `- Screenshot evidence: \`${receipt.deviceAcceptance.screenshot.width}x${receipt.deviceAcceptance.screenshot.height}\`, \`${receipt.deviceAcceptance.screenshot.size}\` bytes, SHA-256 \`${receipt.deviceAcceptance.screenshot.sha256}\``,
    '',
    'The public HAP contains no signing profile or device allow-list. Piora signs a private local copy with the user\'s DevEco-managed profile before installation and keeps that copy in the user data directory. The CI private acceptance HAP, profile extraction, signing descriptor, keystore, passwords, raw developer id, device ids, device serial and runner paths are never staged or uploaded. The receipt contains only certificate fingerprints, hashes, bounded metadata, counts and hashed device identity.',
    '',
    'The retained HongJing-derived editable source and MIT notice are in `third_party/harmony-mirror`. The same-run provenance manifest binds the exact source, artifact, repository, commit, workflow, run and attempt; it does not infer provenance for any previously bundled binary.',
    '',
  ];
  return lines.join('\n');
}

async function writeSourceNote(path, manifest, receipt) {
  await writeFile(path, createHarmonyMirrorSourceNote(manifest, receipt), { flag: 'wx' });
}

export async function readAndVerifySourceNote(resourcesDirectory, manifest, receipt) {
  const bytes = await regularFile(join(resourcesDirectory, MIRROR_SOURCE_FILE), 64 * 1024);
  let actual;
  try { actual = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('SOURCE.md is not valid UTF-8'); }
  if (actual !== createHarmonyMirrorSourceNote(manifest, receipt)) fail('SOURCE.md is stale or does not describe the exact same-run HAP');
  return actual;
}

/** Build/sign/verify/record in one GitHub Actions job on the dedicated runner. */
export async function buildHarmonyMirrorRelease({ projectRoot, workspace, outputDirectory, environment = process.env, now = Date.now() }) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)$/.test(environment.GITHUB_REF_NAME ?? '')) {
    fail('device-bound DevEco signing is preview-only; stable releases require an AGC release certificate and profile');
  }
  const origin = readGitHubBuildOrigin(projectRoot, environment);
  const tools = await resolveHarmonyReleaseTools(environment);
  const signing = await loadDeviceSigningConfig(environment, now);
  const acceptedDeviceTarget = typeof environment.HARMONY_SERIAL === 'string' ? environment.HARMONY_SERIAL.trim() : '';
  if (acceptedDeviceTarget.length < 8 || acceptedDeviceTarget.length > 256 || /\s/.test(acceptedDeviceTarget)) {
    fail('HARMONY_SERIAL must identify the registered acceptance device during signing');
  }
  await prepareHarmonyMirror(workspace, { origin });
  await mkdir(outputDirectory, { recursive: false });
  const env = releaseEnvironment(tools, environment);
  runTool('ohpm dependency resolution', tools.node, [tools.ohpm, 'install', '--all'], { cwd: workspace, env, timeout: 5 * 60_000 });
  try {
    runTool('Hvigor API 26 unsigned release build', tools.node,
      [tools.hvigor, 'clean', '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=release', 'assembleHap', '--no-daemon', '--no-parallel'],
      { cwd: workspace, env, timeout: 20 * 60_000 });
  } finally {
    await rm(join(workspace, '.hvigor'), { recursive: true, force: true });
  }

  const outputRoot = join(workspace, 'entry', 'build', 'default', 'outputs', 'default');
  const unsignedHap = join(outputRoot, 'entry-default-unsigned.hap');
  const manifestPath = join(outputDirectory, ARTIFACT_FILE);
  const manifest = await recordHarmonyMirrorArtifact({
    workspace,
    sourceDirectory: join(projectRoot, 'third_party', 'harmony-mirror'),
    hapPath: unsignedHap,
    manifestPath,
    origin,
  });
  const privateDirectory = join(workspace, '.private-acceptance');
  let retainPrivateAcceptance = false;
  try {
    await mkdir(privateDirectory, { recursive: false });
    const frozenUnsignedHap = join(privateDirectory, 'OHScrcpyServer.unsigned.hap');
    const frozenUnsigned = await freezeRegularFile(unsignedHap, frozenUnsignedHap);
    if (manifest.artifact.size !== frozenUnsigned.size || manifest.artifact.sha256 !== frozenUnsigned.sha256) {
      fail('measured public HAP differs from the frozen signing input');
    }
    const signerOutput = join(privateDirectory, 'OHScrcpyServer.signer-output.hap');
    const signedHap = join(privateDirectory, 'OHScrcpyServer.acceptance.hap');
    let keyPassword;
    let storePassword;
    try {
      const materialDirectory = dirname(signing.signingConfig.material.storeFile);
      [keyPassword, storePassword] = await Promise.all([
        decryptDevEcoProtectedPassword(materialDirectory, signing.signingConfig.material.keyPassword),
        decryptDevEcoProtectedPassword(materialDirectory, signing.signingConfig.material.storePassword),
      ]);
      const material = signing.signingConfig.material;
      await signHapWithJava({
        javaPath: tools.java,
        signToolPath: tools.signTool,
        signerSourcePath: join(projectRoot, 'lib', 'harmony', 'runtime', 'PioraHapSigner.java'),
        keyAlias: material.keyAlias,
        keyPassword,
        certificatePath: material.certpath,
        profilePath: material.profile,
        inputPath: frozenUnsignedHap,
        signAlgorithm: material.signAlg,
        storePath: material.storeFile,
        storePassword,
        outputPath: signerOutput,
        compatibleVersion: 26,
        cwd: workspace,
        env,
        timeoutMs: 120_000,
      });
    } finally {
      keyPassword = undefined;
      storePassword = undefined;
    }
    const frozenAcceptance = await freezeRegularFile(signerOutput, signedHap);
    await rm(signerOutput, { force: true });
    const signingDirectory = join(workspace, '.signing');
    await mkdir(signingDirectory, { recursive: false });
    const verifiedCertificatePath = join(signingDirectory, 'verified-cert-chain.cer');
    const verifiedProfilePath = join(signingDirectory, 'verified-profile.p7b');
    const verifiedProfileJson = join(signingDirectory, 'verified-profile.json');
    let chainBytes, certificates, signingCertificate, profile, acceptedDeviceUdid;
    try {
      runTool('official verify-app', tools.java, ['-jar', tools.signTool, 'verify-app', '-inFile', signedHap,
        '-outCertChain', verifiedCertificatePath, '-outProfile', verifiedProfilePath], {
        cwd: workspace, env, sensitiveOutput: true, redact: signing.secrets,
      });
      runTool('official verify-profile', tools.java, ['-jar', tools.signTool, 'verify-profile', '-inFile', verifiedProfilePath,
        '-outFile', verifiedProfileJson], { cwd: workspace, env, sensitiveOutput: true, redact: signing.secrets });
      chainBytes = await regularFile(verifiedCertificatePath, 1024 * 1024);
      certificates = pemCertificates(chainBytes);
      validateHuaweiDeveloperChain(certificates, now);
      const matchingCertificates = certificates.filter(certificate => certificate.raw.equals(signing.certificate.raw));
      if (matchingCertificates.length !== 1) fail('verify-app returned a different application signing identity');
      [signingCertificate] = matchingCertificates;
      profile = validateVerifiedProfile(await jsonFile(verifiedProfileJson), signing.certificate, now);
      const profileDeviceIds = profile['debug-info']['device-ids'];
      const udidOutput = runTool('registered device UDID query', tools.hdc,
        ['-t', acceptedDeviceTarget, 'shell', 'bm', 'get', '--udid'], {
          cwd: workspace,
          env,
          sensitiveOutput: true,
          redact: [...signing.secrets, acceptedDeviceTarget, ...profileDeviceIds],
        });
      const udidTokens = new Set(extractHarmonyUdids(udidOutput).map(value => value.toLocaleLowerCase()));
      if (udidTokens.size !== 1) fail('dedicated acceptance device returned an ambiguous UDID');
      acceptedDeviceUdid = profileDeviceIds.find(value => udidTokens.has(value.toLocaleLowerCase()));
      if (!acceptedDeviceUdid) fail('DevEco debug profile does not include the dedicated acceptance device');
      await verifyFrozenRegularFile(signedHap, frozenAcceptance);
    } finally {
      await rm(signingDirectory, { recursive: true, force: true });
    }

    await verifyFrozenRegularFile(frozenUnsignedHap, frozenUnsigned);
    await verifyFrozenRegularFile(signedHap, frozenAcceptance);
    const publicHapPath = join(outputDirectory, MIRROR_HAP_FILE);
    await copyFile(frozenUnsignedHap, publicHapPath, 1);
    await verifyFrozenRegularFile(publicHapPath, frozenUnsigned);
    const sdkBytes = await regularFile(tools.signTool, 64 * 1024 * 1024);
    const receipt = {
      schemaVersion: 2,
      kind: 'private-device-acceptance-verification',
      origin,
      artifact: { filename: MIRROR_HAP_FILE, ...frozenUnsigned },
      acceptanceArtifact: { ...frozenAcceptance, sourceSha256: frozenUnsigned.sha256 },
      sdk: { apiVersion: tools.metadata.data.apiVersion, platformVersion: tools.metadata.data.platformVersion,
        toolVersion: tools.metadata.data.version, releaseType: tools.metadata.data.releaseType, signToolSha256: hash(sdkBytes) },
      signing: { mode: 'localSign', material: 'private DevEco acceptance identity', alias: DEVICE_SIGNING_ALIAS,
        profileType: 'debug', compatibleVersion: 26, signCode: true, distribution: 'public artifact remains unsigned' },
      verification: {
        verifyApp: true,
        verifyProfile: true,
        certificate: { issuer: 'Huawei CBG Developer Relations CA G2', trustRoot: 'Huawei CBG Root CA G2',
          sha256Fingerprint: signingCertificate.fingerprint256, validFrom: new Date(signingCertificate.validFrom).toISOString(),
          validTo: new Date(signingCertificate.validTo).toISOString(), currentlyValid: true, chainLength: certificates.length,
          chainSha256: hash(chainBytes) },
        profile: { type: profile.type, issuer: profile.issuer, bundleName: profile['bundle-info']['bundle-name'], apl: profile['bundle-info'].apl,
          appFeature: profile['bundle-info']['app-feature'], notBefore: profile.validity['not-before'],
          notAfter: profile.validity['not-after'], aclCount: profile.acls?.['allowed-acls']?.length ?? 0,
          restrictedPermissionCount: profile.permissions?.['restricted-permissions']?.length ?? 0,
          developerIdSha256: hash(Buffer.from(profile['bundle-info']['developer-id'])),
          deviceIdType: profile['debug-info']['device-id-type'], deviceCount: profile['debug-info']['device-ids'].length,
          boundDeviceSha256: hash(Buffer.from(acceptedDeviceUdid.toLocaleLowerCase())) },
      },
      deviceAcceptance: null,
    };
    const receiptPath = join(outputDirectory, MIRROR_SIGNATURE_FILE);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    await readAndVerifySignatureReceipt(outputDirectory, origin);
    await verifyHarmonyMirrorArtifact({ sourceDirectory: join(projectRoot, 'third_party', 'harmony-mirror'), resourcesDirectory: outputDirectory, expectedOrigin: origin });
    retainPrivateAcceptance = true;
    return { manifest, receipt, tools };
  } finally {
    if (!retainPrivateAcceptance) await rm(privateDirectory, { recursive: true, force: true });
  }
}

export async function attachDeviceAcceptance(resourcesDirectory, expectedOrigin, acceptance) {
  const receiptPath = join(resourcesDirectory, MIRROR_SIGNATURE_FILE);
  const receipt = await readAndVerifySignatureReceipt(resourcesDirectory, expectedOrigin);
  if (receipt.deviceAcceptance !== null) fail('device acceptance is already recorded');
  if (acceptance?.udidSha256 !== receipt.verification.profile.boundDeviceSha256) {
    fail('device acceptance does not match the DevEco profile binding');
  }
  if (acceptance?.acceptedHapSha256 !== receipt.acceptanceArtifact.sha256) {
    fail('device acceptance does not match the private signed HAP');
  }
  const updated = { ...receipt, deviceAcceptance: acceptance };
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, receiptPath);
  const verifiedReceipt = await readAndVerifySignatureReceipt(resourcesDirectory, expectedOrigin, { requireDevice: true });
  const manifest = await jsonFile(join(resourcesDirectory, ARTIFACT_FILE));
  await writeSourceNote(join(resourcesDirectory, MIRROR_SOURCE_FILE), manifest, verifiedReceipt);
  await readAndVerifySourceNote(resourcesDirectory, manifest, verifiedReceipt);
  return updated;
}

export async function verifyStagedHarmonyMirrorRelease({ projectRoot, resourcesDirectory, environment = process.env }) {
  const origin = readGitHubBuildOrigin(projectRoot, environment);
  const manifest = await verifyHarmonyMirrorArtifact({ sourceDirectory: join(projectRoot, 'third_party', 'harmony-mirror'), resourcesDirectory, expectedOrigin: origin });
  const receipt = await readAndVerifySignatureReceipt(resourcesDirectory, origin, { requireDevice: true });
  await readAndVerifySourceNote(resourcesDirectory, manifest, receipt);
  return { manifest, receipt };
}

export async function stageHarmonyMirrorRelease({ projectRoot, resourcesDirectory, targetDirectory, environment = process.env }) {
  await verifyStagedHarmonyMirrorRelease({ projectRoot, resourcesDirectory, environment });
  const publicFiles = [MIRROR_HAP_FILE, ARTIFACT_FILE, MIRROR_SIGNATURE_FILE, MIRROR_SOURCE_FILE];
  const sourceEntries = await readdir(resourcesDirectory);
  if (sourceEntries.length !== publicFiles.length || publicFiles.some(name => !sourceEntries.includes(name))) {
    fail('accepted resource directory must contain only the four public mirror files');
  }
  await mkdir(targetDirectory, { recursive: true });
  const targetStatus = await lstat(targetDirectory);
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) fail('staging target must be a real directory');
  for (const name of publicFiles) {
    await replaceRegularFile(join(resourcesDirectory, name), join(targetDirectory, name));
  }
  await verifyStagedHarmonyMirrorRelease({ projectRoot, resourcesDirectory: targetDirectory, environment });
}
