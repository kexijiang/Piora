import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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
const OFFICIAL_SAMPLE_ALIAS = 'openharmony application release';
const OFFICIAL_PROFILE_ALIAS = 'openharmony application profile release';
const OFFICIAL_APP_CA_ALIAS = 'openharmony application ca';
const OFFICIAL_ROOT_CA_CERT_ALIAS = 'rootcacert';
const OFFICIAL_SUB_CA_CERT_ALIAS = 'cacert';
const OFFICIAL_APP_CA_SUBJECT = 'C=CN,O=OpenHarmony,OU=OpenHarmony Team,CN=OpenHarmony Application CA';
const OFFICIAL_APP_SUBJECT = 'C=CN,O=OpenHarmony,OU=OpenHarmony Team,CN=OpenHarmony Application Release';
const APPLICATION_CERT_VALIDITY_DAYS = 3650;
// This is the documented password for the public OpenHarmony SDK sample key.
// It is not a project or user credential. The key itself is loaded from the
// installed SDK and is never copied into the repository or workflow artifact.
const OFFICIAL_SAMPLE_PASSWORD = '123456';
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
    const detail = output.slice(-8_000).replaceAll(OFFICIAL_SAMPLE_PASSWORD, '<sdk-sample-password>');
    fail(`${label} failed${result.status === null ? '' : ` with exit ${result.status}`}${detail ? `\n${detail}` : ''}`);
  }
  return output;
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
    keytool: pathFromEnvironment(environment, 'HARMONY_KEYTOOL_PATH') ?? join(studioRoot, 'jbr', 'bin', 'keytool.exe'),
    hvigor: pathFromEnvironment(environment, 'HARMONY_HVIGOR_PATH') ?? join(studioRoot, 'tools', 'hvigor', 'bin', 'hvigorw.js'),
    ohpm: pathFromEnvironment(environment, 'HARMONY_OHPM_PATH') ?? join(studioRoot, 'tools', 'ohpm', 'bin', 'pm-cli.js'),
    hdc: pathFromEnvironment(environment, 'HARMONY_HDC_PATH') ?? join(toolchains, 'hdc.exe'),
    signTool: join(library, 'hap-sign-tool.jar'),
    keyStore: join(library, 'OpenHarmony.p12'),
    profileCertificate: join(library, 'OpenHarmonyProfileRelease.pem'),
    profileTemplate: join(library, 'UnsgnedReleasedProfileTemplate.json'),
    sdkMetadata: join(sdkDefault, 'sdk-pkg.json'),
  };
  for (const [name, path] of Object.entries(tools)) {
    if (name === 'sdkRoot' || name === 'sdkDefault') continue;
    const maximum = name === 'node' ? 256 * 1024 * 1024 : name === 'signTool' ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
    await regularFile(path, maximum);
  }
  const metadata = await jsonFile(tools.sdkMetadata);
  if (metadata.data?.apiVersion !== '26' || metadata.data?.platformVersion !== '26.0.0') fail('runner must provide the reviewed HarmonyOS API 26 SDK');
  const profileCertificates = pemCertificates(await regularFile(tools.profileCertificate, 1024 * 1024));
  const profileLeaves = profileCertificates.filter(certificate => certificate.subject.includes('CN=OpenHarmony Application Profile Release'));
  const now = Date.now();
  if (profileLeaves.length !== 1 || new Date(profileLeaves[0].validFrom).getTime() > now
    || new Date(profileLeaves[0].validTo).getTime() <= now) fail('SDK example profile certificate is missing, ambiguous or not currently valid');
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

export function createApplicationCertificateArguments({ signTool, keyStore, rootCertificate, subCertificate, outputCertificate }) {
  return ['-jar', signTool, 'generate-app-cert',
    '-keyAlias', OFFICIAL_SAMPLE_ALIAS, '-keyPwd', OFFICIAL_SAMPLE_PASSWORD,
    '-issuer', OFFICIAL_APP_CA_SUBJECT, '-issuerKeyAlias', OFFICIAL_APP_CA_ALIAS,
    '-issuerKeyPwd', OFFICIAL_SAMPLE_PASSWORD, '-subject', OFFICIAL_APP_SUBJECT,
    '-validity', String(APPLICATION_CERT_VALIDITY_DAYS), '-signAlg', 'SHA256withECDSA',
    '-rootCaCertFile', rootCertificate, '-subCaCertFile', subCertificate,
    '-keystoreFile', keyStore, '-keystorePwd', OFFICIAL_SAMPLE_PASSWORD,
    '-outForm', 'certChain', '-outFile', outputCertificate, '-pwdInputMode', '0'];
}

export function createOrdinaryReleaseProfile({ distributionCertificate, now = Date.now(), uuid = randomUUID() }) {
  const notBefore = Math.floor(now / 1000) - 60 * 60;
  const notAfter = notBefore + 5 * 365 * 24 * 60 * 60;
  return {
    'version-name': '2.0.0',
    'version-code': 2,
    'app-distribution-type': 'os_integration',
    uuid,
    validity: { 'not-before': notBefore, 'not-after': notAfter },
    type: 'release',
    'bundle-info': {
      'developer-id': 'OpenHarmony',
      'distribution-certificate': distributionCertificate,
      'bundle-name': MIRROR_BUNDLE,
      apl: 'normal',
      'app-feature': 'hos_normal_app',
    },
    acls: { 'allowed-acls': [] },
    permissions: { 'restricted-permissions': [] },
    issuer: 'pki_internal',
  };
}

function pemCertificateBlocks(bytes) {
  return bytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function pemCertificates(bytes) {
  return pemCertificateBlocks(bytes).map(value => new X509Certificate(value));
}

function validateVerifiedProfile(result, expectedCertificate, now = Date.now()) {
  if (result?.verifiedPassed !== true || result.message !== 'OK') fail('official verify-profile did not pass');
  const profile = result.content;
  const info = profile?.['bundle-info'];
  if (profile?.type !== 'release' || profile?.['app-distribution-type'] !== 'os_integration'
    || info?.['bundle-name'] !== MIRROR_BUNDLE || info?.apl !== 'normal' || info?.['app-feature'] !== 'hos_normal_app') {
    fail('verified profile is not the ordinary release identity');
  }
  const acls = profile.acls?.['allowed-acls'];
  if ((acls !== undefined && (!Array.isArray(acls) || acls.length !== 0))
    || !Array.isArray(profile.permissions?.['restricted-permissions'])
    || profile.permissions['restricted-permissions'].length !== 0
    || profile['app-privilege-capabilities'] !== undefined) fail('verified profile contains privileges or ACLs');
  if (!Number.isSafeInteger(profile.validity?.['not-before']) || !Number.isSafeInteger(profile.validity?.['not-after'])
    || profile.validity['not-before'] * 1000 > now || profile.validity['not-after'] * 1000 <= now) fail('verified profile is not currently valid');
  let embedded;
  try { embedded = new X509Certificate(info['distribution-certificate']); } catch { fail('verified profile has an invalid distribution certificate'); }
  if (!embedded.raw.equals(expectedCertificate.raw)) fail('profile distribution certificate differs from the application signing leaf');
  return profile;
}

export async function readAndVerifySignatureReceipt(resourcesDirectory, expectedOrigin, options = {}) {
  const receipt = await jsonFile(join(resourcesDirectory, MIRROR_SIGNATURE_FILE));
  const expectedKeys = ['schemaVersion', 'kind', 'origin', 'artifact', 'sdk', 'signing', 'verification', 'deviceAcceptance'].sort();
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
    || receipt.schemaVersion !== 1 || receipt.kind !== 'ordinary-mirror-signature-verification'
    || JSON.stringify(receipt.origin) !== JSON.stringify(expectedOrigin)) fail('signature receipt has an unsupported shape or CI identity');
  const hap = await regularFile(join(resourcesDirectory, MIRROR_HAP_FILE));
  if (!exactKeys(receipt.artifact, ['filename', 'size', 'sha256'])
    || receipt.artifact.filename !== MIRROR_HAP_FILE || receipt.artifact.size !== hap.length || receipt.artifact.sha256 !== hash(hap)) fail('signature receipt does not bind the staged HAP');
  if (!exactKeys(receipt.sdk, ['apiVersion', 'platformVersion', 'toolVersion', 'releaseType', 'signToolSha256'])
    || receipt.sdk.apiVersion !== '26' || receipt.sdk.platformVersion !== '26.0.0'
    || !/^26\.0\.0\.\d+$/.test(receipt.sdk.toolVersion ?? '') || typeof receipt.sdk.releaseType !== 'string'
    || receipt.sdk.releaseType.length < 1 || receipt.sdk.releaseType.length > 32
    || !/^[0-9a-f]{64}$/.test(receipt.sdk.signToolSha256 ?? '')) fail('signature receipt does not identify the reviewed API 26 tool');
  if (!exactKeys(receipt.signing, ['mode', 'material', 'alias', 'profileAlias', 'compatibleVersion', 'signCode'])
    || receipt.signing.mode !== 'localSign' || receipt.signing.material !== 'OpenHarmony SDK release example'
    || receipt.signing.alias !== OFFICIAL_SAMPLE_ALIAS || receipt.signing.profileAlias !== OFFICIAL_PROFILE_ALIAS
    || receipt.signing.compatibleVersion !== 26 || receipt.signing.signCode !== true) fail('signature receipt describes an unsupported signing flow');
  const certificate = receipt.verification?.certificate;
  const certificateFrom = typeof certificate?.validFrom === 'string' ? new Date(certificate.validFrom) : new Date(Number.NaN);
  const certificateTo = typeof certificate?.validTo === 'string' ? new Date(certificate.validTo) : new Date(Number.NaN);
  const profile = receipt.verification?.profile;
  const now = Date.now();
  if (!exactKeys(receipt.verification, ['verifyApp', 'verifyProfile', 'certificate', 'profile'])
    || !exactKeys(certificate, ['subject', 'issuer', 'sha256Fingerprint', 'validFrom', 'validTo', 'currentlyValid', 'chainLength', 'chainSha256'])
    || !exactKeys(profile, ['type', 'distributionType', 'bundleName', 'apl', 'appFeature', 'notBefore', 'notAfter', 'aclCount', 'restrictedPermissionCount'])
    || receipt.verification.verifyApp !== true || receipt.verification.verifyProfile !== true
    || profile.type !== 'release' || profile.distributionType !== 'os_integration'
    || receipt.verification?.profile?.bundleName !== MIRROR_BUNDLE || receipt.verification?.profile?.apl !== 'normal'
    || receipt.verification?.profile?.appFeature !== 'hos_normal_app' || receipt.verification?.profile?.aclCount !== 0
    || profile.restrictedPermissionCount !== 0 || !boundedInteger(profile.notBefore, 0, 9_007_199_254_740)
    || !boundedInteger(profile.notAfter, profile.notBefore + 1, 9_007_199_254_740)
    || profile.notBefore * 1000 > now || profile.notAfter * 1000 <= now
    || certificate.currentlyValid !== true || typeof certificate.subject !== 'string'
    || !certificate.subject.includes('CN=OpenHarmony Application Release') || typeof certificate.issuer !== 'string'
    || !/^[0-9A-F:]{95}$/.test(certificate.sha256Fingerprint ?? '')
    || !/^[0-9a-f]{64}$/.test(certificate.chainSha256 ?? '') || !boundedInteger(certificate.chainLength, 2, 16)
    || Number.isNaN(certificateFrom.getTime()) || Number.isNaN(certificateTo.getTime())
    || certificateFrom.toISOString() !== certificate.validFrom || certificateTo.toISOString() !== certificate.validTo
    || certificateFrom.getTime() > now || certificateTo.getTime() <= now) fail('official signature verification receipt is incomplete');
  if (options.requireDevice) {
    const device = receipt.deviceAcceptance;
    const acceptedAt = typeof device?.acceptedAt === 'string' ? new Date(device.acceptedAt) : new Date(Number.NaN);
    if (!exactKeys(device, ['passed', 'acceptedAt', 'serialSha256', 'installVerified', 'launchVerified', 'consentVerified', 'video', 'screenshot', 'cleanup'])
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
      || !/^[0-9a-f]{64}$/.test(device.serialSha256 ?? '')) fail('real-device acceptance is missing or incomplete');
  } else if (receipt.deviceAcceptance !== null) fail('pre-device signature receipt must not claim hardware acceptance');
  return receipt;
}

export function createHarmonyMirrorSourceNote(manifest, receipt) {
  const lines = [
    '# Piora Harmony mirror release resource',
    '',
    'This directory was staged by the tagged GitHub Actions run recorded below. The HAP was built from `third_party/harmony-mirror` in an isolated workspace, signed with the public OpenHarmony SDK release example identity, verified with the same API 26 SDK `verify-app` and `verify-profile` commands, and accepted on the dedicated HDC development phone before desktop packaging.',
    '',
    `- Repository: \`${manifest.origin.repository}\``,
    `- Commit: \`${manifest.origin.commit}\``,
    `- Workflow: \`${manifest.origin.workflowRef}\``,
    `- Run: \`${manifest.origin.runId}\` (attempt \`${manifest.origin.runAttempt}\`)`,
    `- Source tree SHA-256: \`${manifest.sourceTreeSha256}\``,
    `- HAP SHA-256: \`${manifest.artifact.sha256}\``,
    `- HAP size: \`${manifest.artifact.size}\` bytes`,
    `- Component: \`${manifest.artifact.component.bundleName}\` \`${manifest.artifact.component.versionName}\` (\`${manifest.artifact.component.versionCode}\`)`,
    `- SDK: \`${receipt.sdk.toolVersion}\``,
    `- Signing receipt: \`${MIRROR_SIGNATURE_FILE}\``,
    `- Device accepted: \`${receipt.deviceAcceptance.acceptedAt}\``,
    `- Native H.264 video evidence: \`${receipt.deviceAcceptance.video.width}x${receipt.deviceAcceptance.video.height}@${receipt.deviceAcceptance.video.fps}\`, \`${receipt.deviceAcceptance.video.configurationPackets}\` configuration packet(s), \`${receipt.deviceAcceptance.video.frames}\` frame(s), \`${receipt.deviceAcceptance.video.keyframes}\` IDR frame(s), \`${receipt.deviceAcceptance.video.bytes}\` bytes`,
    `- Screenshot evidence: \`${receipt.deviceAcceptance.screenshot.width}x${receipt.deviceAcceptance.screenshot.height}\`, \`${receipt.deviceAcceptance.screenshot.size}\` bytes, SHA-256 \`${receipt.deviceAcceptance.screenshot.sha256}\``,
    '',
    'The SDK example identity is intended for HDC development devices and is not an AppGallery distribution identity. No keystore, private key, password, certificate output, signed profile output, device serial, or runner path is included. The checked receipt contains only public fingerprints, hashes, bounded metadata, and the hashed device identity.',
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
  const origin = readGitHubBuildOrigin(projectRoot, environment);
  const tools = await resolveHarmonyReleaseTools(environment);
  await prepareHarmonyMirror(workspace, { origin });
  await mkdir(outputDirectory, { recursive: false });
  const env = releaseEnvironment(tools, environment);
  runTool('ohpm dependency resolution', tools.node, [tools.ohpm, 'install', '--all'], { cwd: workspace, env, timeout: 5 * 60_000 });
  runTool('Hvigor API 26 release build', tools.node,
    [tools.hvigor, 'clean', '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=release', 'assembleHap', '--no-daemon', '--no-parallel'],
    { cwd: workspace, env, timeout: 20 * 60_000 });

  const outputRoot = join(workspace, 'entry', 'build', 'default', 'outputs', 'default');
  const unsignedHap = join(outputRoot, 'entry-default-unsigned.hap');
  const signedHap = join(outputRoot, 'entry-default-signed.hap');
  await regularFile(unsignedHap);
  const signingDirectory = join(workspace, '.signing');
  await mkdir(signingDirectory, { recursive: false });
  const template = await jsonFile(tools.profileTemplate);
  const templateDistributionCertificate = template?.['bundle-info']?.['distribution-certificate'];
  let templateCertificate;
  try { templateCertificate = new X509Certificate(templateDistributionCertificate); } catch { fail('SDK release template lacks a valid application certificate'); }
  if (!templateCertificate.subject.includes('CN=OpenHarmony Application Release')
    || new Date(templateCertificate.validFrom).getTime() > now || new Date(templateCertificate.validTo).getTime() <= now) fail('SDK example application certificate is not currently valid');
  const applicationCertificate = join(signingDirectory, 'application-release.cer');
  const rootCertificatePath = join(signingDirectory, 'application-root-ca.cer');
  const subCertificatePath = join(signingDirectory, 'application-ca.cer');
  const unsignedProfile = join(signingDirectory, 'ordinary-release-profile.json');
  const signedProfile = join(signingDirectory, 'ordinary-release-profile.p7b');

  const certificateExport = alias => ['-exportcert', '-rfc', '-alias', alias, '-keystore', tools.keyStore,
    '-storetype', 'PKCS12', '-storepass', OFFICIAL_SAMPLE_PASSWORD, '-noprompt'];
  runTool('SDK application root certificate export', tools.keytool,
    [...certificateExport(OFFICIAL_ROOT_CA_CERT_ALIAS), '-file', rootCertificatePath], { cwd: workspace, env });
  runTool('SDK application CA certificate export', tools.keytool,
    [...certificateExport(OFFICIAL_SUB_CA_CERT_ALIAS), '-file', subCertificatePath], { cwd: workspace, env });
  const rootCertificates = pemCertificates(await regularFile(rootCertificatePath, 1024 * 1024));
  const subCertificates = pemCertificates(await regularFile(subCertificatePath, 1024 * 1024));
  const rootCertificate = rootCertificates[0];
  const subCertificate = subCertificates[0];
  const certificateNow = Date.now();
  if (rootCertificates.length !== 1 || subCertificates.length !== 1
    || !rootCertificate?.ca || !subCertificate?.ca
    || !rootCertificate.subject.includes('CN=OpenHarmony Application Root CA')
    || !subCertificate.subject.includes('CN=OpenHarmony Application CA')
    || subCertificate.issuer !== rootCertificate.subject || rootCertificate.issuer !== rootCertificate.subject
    || !subCertificate.verify(rootCertificate.publicKey) || !rootCertificate.verify(rootCertificate.publicKey)
    || new Date(rootCertificate.validFrom).getTime() > certificateNow || new Date(rootCertificate.validTo).getTime() <= certificateNow
    || new Date(subCertificate.validFrom).getTime() > certificateNow || new Date(subCertificate.validTo).getTime() <= certificateNow) {
    fail('SDK application certificate authorities are missing, invalid or expired');
  }
  runTool('official application certificate chain generation', tools.java,
    createApplicationCertificateArguments({ signTool: tools.signTool, keyStore: tools.keyStore,
      rootCertificate: rootCertificatePath, subCertificate: subCertificatePath, outputCertificate: applicationCertificate }),
    { cwd: workspace, env });
  const applicationCertificateBytes = await regularFile(applicationCertificate, 1024 * 1024);
  const applicationCertificateBlocks = pemCertificateBlocks(applicationCertificateBytes);
  const applicationCertificates = applicationCertificateBlocks.map(value => new X509Certificate(value));
  const [expectedCertificate, generatedSubCertificate, generatedRootCertificate] = applicationCertificates;
  if (applicationCertificates.length !== 3 || !expectedCertificate || expectedCertificate.ca
    || !expectedCertificate.subject.includes('CN=OpenHarmony Application Release')
    || expectedCertificate.issuer !== subCertificate.subject
    || !generatedSubCertificate?.raw.equals(subCertificate.raw) || !generatedRootCertificate?.raw.equals(rootCertificate.raw)
    || !expectedCertificate.verify(subCertificate.publicKey)
    || new Date(expectedCertificate.validFrom).getTime() > Date.now()
    || new Date(expectedCertificate.validTo).getTime() <= Date.now()) {
    fail('official application certificate generation did not return the expected three-certificate chain');
  }
  const ordinaryProfile = createOrdinaryReleaseProfile({ distributionCertificate: applicationCertificateBlocks[0], now });
  if (ordinaryProfile.validity['not-after'] * 1000 > new Date(expectedCertificate.validTo).getTime()) {
    fail('generated application certificate expires before the ordinary release profile');
  }
  await writeFile(unsignedProfile, `${JSON.stringify(ordinaryProfile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  const commonSigning = ['-keystoreFile', tools.keyStore, '-keystorePwd', OFFICIAL_SAMPLE_PASSWORD, '-keyPwd', OFFICIAL_SAMPLE_PASSWORD, '-pwdInputMode', '0'];
  runTool('official profile signing', tools.java, ['-jar', tools.signTool, 'sign-profile', '-mode', 'localSign',
    '-keyAlias', OFFICIAL_PROFILE_ALIAS, '-profileCertFile', tools.profileCertificate, '-inFile', unsignedProfile,
    '-signAlg', 'SHA256withECDSA', ...commonSigning, '-outFile', signedProfile], { cwd: workspace, env });
  runTool('official application signing', tools.java, ['-jar', tools.signTool, 'sign-app', '-mode', 'localSign',
    '-keyAlias', OFFICIAL_SAMPLE_ALIAS, '-appCertFile', applicationCertificate, '-profileFile', signedProfile, '-profileSigned', '1',
    '-inFile', unsignedHap, '-signAlg', 'SHA256withECDSA', ...commonSigning, '-outFile', signedHap,
    '-compatibleVersion', '26', '-signCode', '1'], { cwd: workspace, env });

  const verifiedCertificatePath = join(signingDirectory, 'verified-cert-chain.cer');
  const verifiedProfilePath = join(signingDirectory, 'verified-profile.p7b');
  const verifiedProfileJson = join(signingDirectory, 'verified-profile.json');
  runTool('official verify-app', tools.java, ['-jar', tools.signTool, 'verify-app', '-inFile', signedHap,
    '-outCertChain', verifiedCertificatePath, '-outProfile', verifiedProfilePath], { cwd: workspace, env });
  runTool('official verify-profile', tools.java, ['-jar', tools.signTool, 'verify-profile', '-inFile', verifiedProfilePath,
    '-outFile', verifiedProfileJson], { cwd: workspace, env });
  const chainBytes = await regularFile(verifiedCertificatePath, 1024 * 1024);
  const certificates = pemCertificates(chainBytes);
  const matchingCertificates = certificates.filter(certificate => certificate.raw.equals(expectedCertificate.raw));
  if (certificates.length < 2 || matchingCertificates.length !== 1) fail('verify-app returned an unexpected application certificate chain');
  const signingCertificate = matchingCertificates[0];
  const profile = validateVerifiedProfile(await jsonFile(verifiedProfileJson), expectedCertificate, now);

  const manifestPath = join(outputDirectory, ARTIFACT_FILE);
  const manifest = await recordHarmonyMirrorArtifact({
    workspace,
    sourceDirectory: join(projectRoot, 'third_party', 'harmony-mirror'),
    hapPath: signedHap,
    manifestPath,
    origin,
  });
  const hapBytes = await regularFile(signedHap);
  await copyFile(signedHap, join(outputDirectory, MIRROR_HAP_FILE), 1);
  const sdkBytes = await regularFile(tools.signTool, 64 * 1024 * 1024);
  const receipt = {
    schemaVersion: 1,
    kind: 'ordinary-mirror-signature-verification',
    origin,
    artifact: { filename: MIRROR_HAP_FILE, size: hapBytes.length, sha256: hash(hapBytes) },
    sdk: { apiVersion: tools.metadata.data.apiVersion, platformVersion: tools.metadata.data.platformVersion,
      toolVersion: tools.metadata.data.version, releaseType: tools.metadata.data.releaseType, signToolSha256: hash(sdkBytes) },
    signing: { mode: 'localSign', material: 'OpenHarmony SDK release example', alias: OFFICIAL_SAMPLE_ALIAS,
      profileAlias: OFFICIAL_PROFILE_ALIAS, compatibleVersion: 26, signCode: true },
    verification: {
      verifyApp: true,
      verifyProfile: true,
      certificate: { subject: signingCertificate.subject, issuer: signingCertificate.issuer,
        sha256Fingerprint: signingCertificate.fingerprint256, validFrom: new Date(signingCertificate.validFrom).toISOString(),
        validTo: new Date(signingCertificate.validTo).toISOString(), currentlyValid: true, chainLength: certificates.length,
        chainSha256: hash(chainBytes) },
      profile: { type: profile.type, distributionType: profile['app-distribution-type'],
        bundleName: profile['bundle-info']['bundle-name'], apl: profile['bundle-info'].apl,
        appFeature: profile['bundle-info']['app-feature'], notBefore: profile.validity['not-before'],
        notAfter: profile.validity['not-after'], aclCount: profile.acls?.['allowed-acls']?.length ?? 0,
        restrictedPermissionCount: profile.permissions['restricted-permissions'].length },
    },
    deviceAcceptance: null,
  };
  const receiptPath = join(outputDirectory, MIRROR_SIGNATURE_FILE);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  await readAndVerifySignatureReceipt(outputDirectory, origin);
  await verifyHarmonyMirrorArtifact({ sourceDirectory: join(projectRoot, 'third_party', 'harmony-mirror'), resourcesDirectory: outputDirectory, expectedOrigin: origin });
  return { manifest, receipt, tools };
}

export async function attachDeviceAcceptance(resourcesDirectory, expectedOrigin, acceptance) {
  const receiptPath = join(resourcesDirectory, MIRROR_SIGNATURE_FILE);
  const receipt = await readAndVerifySignatureReceipt(resourcesDirectory, expectedOrigin);
  if (receipt.deviceAcceptance !== null) fail('device acceptance is already recorded');
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
  await mkdir(targetDirectory, { recursive: true });
  const targetStatus = await lstat(targetDirectory);
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) fail('staging target must be a real directory');
  for (const name of [MIRROR_HAP_FILE, ARTIFACT_FILE, MIRROR_SIGNATURE_FILE, MIRROR_SOURCE_FILE]) {
    await replaceRegularFile(join(resourcesDirectory, name), join(targetDirectory, name));
  }
  await verifyStagedHarmonyMirrorRelease({ projectRoot, resourcesDirectory: targetDirectory, environment });
}
