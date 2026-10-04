import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';

export const PREPARATION_FILE = '.piora-mirror-source.json';
export const ARTIFACT_FILE = 'harmony-mirror-manifest.json';
const MAX_FILE = 256 * 1024 * 1024;
const MAX_SOURCE = 64 * 1024 * 1024;
const MANIFEST_SCOPE = 'Measured source fingerprint and artifact metadata/hash; this does not prove SDK compilation, signature trust or distribution eligibility.';
const GENERATED_LOCKS = ['entry/oh-package-lock.json5', 'oh-package-lock.json5'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw new Error(`Harmony mirror provenance: ${message}`); };

/** The same exclusions apply to copying and measuring the unsigned source. */
export function includeMirrorSource(path) {
  return !/(?:^|[/\\])(?:build|\.hvigor|\.cxx|oh_modules|node_modules|\.signing|signing)(?:[/\\]|$)/.test(path)
    && !/(?:local\.properties|\.(?:p12|p7b|cer|pem|key))$/i.test(path)
    && ![PREPARATION_FILE, ARTIFACT_FILE].includes(path.split(/[/\\]/).at(-1));
}

async function regularFile(path, limit = MAX_FILE, allowEmpty = false) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit || (!allowEmpty && before.size === 0)) fail('expected a bounded regular file');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail('file changed while being measured');
  return bytes;
}

async function jsonFile(path, limit = 1024 * 1024) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await regularFile(path, limit))); }
  catch (error) { fail(`cannot read required JSON ${path.split(/[/\\]/).at(-1)} (${error.code ?? 'invalid or missing'})`); }
}

function stringList(items) {
  if (!Array.isArray(items) || items.some(item => typeof (typeof item === 'string' ? item : item?.name) !== 'string')) fail('invalid package metadata list');
  const values = items.map(item => typeof item === 'string' ? item : item.name).sort();
  if (new Set(values).size !== values.length) fail('duplicate package metadata');
  return values;
}

function componentMetadata(app, moduleInfo) {
  if (!app || !moduleInfo || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(app.bundleName ?? '')
    || typeof app.versionName !== 'string' || !app.versionName || !Number.isSafeInteger(app.versionCode) || app.versionCode <= 0
    || moduleInfo.name !== 'entry' || moduleInfo.type !== 'entry' || moduleInfo.mainElement !== 'EntryAbility') fail('unsupported ordinary package identity, version or entry');
  const abilities = stringList(moduleInfo.abilities);
  const permissions = stringList(moduleInfo.requestPermissions ?? []);
  if (!equal(abilities, ['EntryAbility']) || !equal(permissions, ['ohos.permission.INTERNET', 'ohos.permission.KEEP_BACKGROUND_RUNNING'])) fail('package is not the ordinary capture component');
  const backgroundModes = stringList(moduleInfo.abilities[0].backgroundModes ?? []);
  const deviceTypes = stringList(moduleInfo.deviceTypes);
  if (!equal(backgroundModes, ['avPlaybackAndRecord']) || !equal(deviceTypes, ['phone', 'tablet']) || moduleInfo.abilities[0].exported !== true) fail('package lacks the ordinary foreground/background ability contract');
  return { bundleName: app.bundleName, versionName: app.versionName, versionCode: app.versionCode,
    moduleName: moduleInfo.name, moduleType: moduleInfo.type, mainElement: moduleInfo.mainElement, abilities, permissions, backgroundModes, deviceTypes };
}

export async function snapshotHarmonyMirrorSource(sourceDirectory) {
  const root = resolve(sourceDirectory);
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) fail('source root must be a real directory');
  const files = []; let total = 0;
  async function walk(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!includeMirrorSource(name)) continue;
      if (entry.isSymbolicLink() || /[\u0000-\u001f\\]/.test(entry.name)) fail('source contains a symlink or unsupported path');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) {
        const bytes = await regularFile(path, 16 * 1024 * 1024, true);
        total += bytes.length;
        if (total > MAX_SOURCE || files.length >= 10000) fail('source exceeds measurement limits');
        files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
      } else fail('source contains a nonregular entry');
    }
  }
  await walk(root);
  const app = await jsonFile(join(root, 'AppScope/app.json5'));
  const moduleInfo = await jsonFile(join(root, 'entry/src/main/module.json5'));
  const packageInfo = await jsonFile(join(root, 'oh-package.json5'));
  const profile = await jsonFile(join(root, 'build-profile.json5'));
  const nativeProfile = await jsonFile(join(root, 'entry/build-profile.json5'));
  if (profile.app?.signingConfigs !== undefined || profile.app?.products?.some(product => product.signingConfig !== undefined)) fail('source contains signing configuration');
  const product = profile.app?.products?.find(item => item.name === 'default');
  if (product?.compatibleSdkVersion !== '26.0.0' || product?.targetSdkVersion !== '26.0.0'
    || !equal(nativeProfile.buildOption?.externalNativeOptions?.abiFilters, ['arm64-v8a'])) fail('source API or ABI is unsupported');
  const component = componentMetadata(app.app, moduleInfo.module);
  if (packageInfo.version !== component.versionName) fail('source package versions disagree');
  return { schemaVersion: 1, kind: 'ordinary-mirror-source', component, api: '26.0.0', abi: 'arm64-v8a',
    sourceTreeSha256: hash(JSON.stringify(files)), files };
}

export function readGitHubBuildOrigin(projectRoot, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true') fail('packaging requires a GitHub Actions build identity');
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: commit, GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: runAttempt, GITHUB_WORKFLOW_REF: workflowRef } = environment;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[0-9a-f]{40}$/.test(commit ?? '')
    || !/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(runAttempt ?? '')
    || typeof workflowRef !== 'string' || !workflowRef.startsWith(`${repository}/.github/workflows/`) || !workflowRef.includes('@refs/')) fail('incomplete GitHub Actions build identity');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim();
  if (actual !== commit) fail('checkout commit differs from GitHub Actions commit');
  return { repository, commit, runId, runAttempt, workflowRef };
}

/** Record measured input, not a claim that an SDK build or signature has passed. */
export async function writeMirrorPreparation(workspace, sourceDirectory, origin = null) {
  const [source, prepared] = await Promise.all([snapshotHarmonyMirrorSource(sourceDirectory), snapshotHarmonyMirrorSource(workspace)]);
  if (!equal(source, prepared)) fail('prepared source differs from repository source');
  await writeFile(join(workspace, PREPARATION_FILE), `${JSON.stringify({ ...prepared, origin }, null, 2)}\n`, { flag: 'wx' });
}

function separateGeneratedBuildInputs(prepared, source) {
  const originalPaths = new Set(source.files.map(file => file.path));
  const generatedBuildInputs = prepared.files.filter(file => !originalPaths.has(file.path) && GENERATED_LOCKS.includes(file.path));
  const generatedPaths = new Set(generatedBuildInputs.map(file => file.path));
  const files = prepared.files.filter(file => !generatedPaths.has(file.path));
  // Committed lock files remain in the source hash. Only new, explicitly named
  // ohpm outputs are measured separately; arbitrary new source is still rejected.
  return { source: { ...prepared, files, sourceTreeSha256: hash(JSON.stringify(files)) }, generatedBuildInputs };
}

async function boundedZipEntry(entry, remaining) {
  return new Promise((resolveBytes, reject) => {
    const stream = entry.internalStream('nodebuffer'); const chunks = []; let size = 0, ended = false;
    const stop = error => { if (ended) return; ended = true; stream.pause(); reject(error); };
    stream.on('data', chunk => { size += chunk.length; if (size > remaining) stop(new Error('Harmony mirror provenance: expanded package exceeds limit')); else chunks.push(chunk); });
    stream.on('error', stop);
    stream.on('end', () => { if (!ended) { ended = true; resolveBytes(Buffer.concat(chunks)); } });
    stream.resume();
  });
}

async function measureHap(path) {
  const bytes = await regularFile(path);
  let zip;
  try { zip = await JSZip.loadAsync(bytes, { createFolders: false }); } catch { fail('artifact is not a readable HAP ZIP'); }
  if (Object.keys(zip.files).length > 20000) fail('artifact has too many ZIP entries');
  const metadataEntry = zip.file('module.json');
  if (!metadataEntry || metadataEntry.unsafeOriginalName !== 'module.json') fail('artifact lacks regular root module.json');
  let metadata;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedZipEntry(metadataEntry, 512 * 1024))); }
  catch { fail('artifact metadata is invalid or exceeds limit'); }
  const component = componentMetadata(metadata.app, metadata.module);
  // API-26 HarmonyOS SDK package metadata uses the extended API integer.
  // A different SDK encoding requires an explicit review, never a silent fallback.
  const build = { minAPIVersion: metadata.app.minAPIVersion, targetAPIVersion: metadata.app.targetAPIVersion,
    compileSdkType: metadata.app.compileSdkType, compileSdkVersion: metadata.app.compileSdkVersion, buildMode: metadata.app.buildMode };
  if (build.minAPIVersion !== 260000026 || build.targetAPIVersion !== 260000026 || build.compileSdkType !== 'HarmonyOS'
    || !/^26\.0\.0\.\d+$/.test(build.compileSdkVersion ?? '') || build.buildMode !== 'release' || metadata.app.debug !== false) fail('artifact must be an API-26 HarmonyOS release build; debug is not a distribution artifact');
  if (!zip.file('libs/arm64-v8a/libscrcpy_capture.so')) fail('artifact lacks the ordinary arm64 capture library');
  let expanded = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (entry.unsafeOriginalName !== entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..')) fail('artifact contains an unsafe ZIP path');
    if (entry.name.endsWith('.so') && !entry.name.startsWith('libs/arm64-v8a/')) fail('artifact contains an unexpected native ABI');
    const contents = await boundedZipEntry(entry, MAX_FILE - expanded); expanded += contents.length;
    if (/TestBridge|BridgeSession|PcmTestInputSource|pioraPcmPacket|appTestPairing|AtlasFixture|atlas-action-increment|atlas-encrypted-prepare|atlas-landscape|atlas-portrait/.test(entry.name + '\n' + contents.toString('utf8'))) fail('artifact contains debug acceptance symbols');
  }
  return { filename: 'OHScrcpyServer.hap', size: bytes.length, sha256: hash(bytes), component, build };
}

/** Called after a real CI build. This only binds measured source/artifact metadata. */
export async function recordHarmonyMirrorArtifact({ workspace, sourceDirectory, hapPath, manifestPath, origin }) {
  if (!origin) fail('artifact recording requires a current CI identity');
  const receipt = await jsonFile(join(workspace, PREPARATION_FILE), 4 * 1024 * 1024);
  const [source, preparedSnapshot] = await Promise.all([snapshotHarmonyMirrorSource(sourceDirectory), snapshotHarmonyMirrorSource(workspace)]);
  const prepared = separateGeneratedBuildInputs(preparedSnapshot, source);
  const { origin: preparationOrigin, ...snapshot } = receipt;
  if (!equal(preparationOrigin, origin) || !equal(snapshot, source) || !equal(source, prepared.source)) fail('source receipt, current source or CI identity changed');
  const location = relative(resolve(workspace), resolve(hapPath));
  if (isAbsolute(location) || location.startsWith(`..${sep}`) || location === '..'
    || !/^entry\/build\/default\/outputs\/default\/entry-default-signed\.hap$/.test(location.split(sep).join('/'))) fail('record only the current workspace entry/default signed output');
  const physicalLocation = relative(await realpath(workspace), await realpath(hapPath));
  if (isAbsolute(physicalLocation) || physicalLocation.startsWith(`..${sep}`) || physicalLocation === '..') fail('artifact resolves outside the prepared workspace');
  const artifact = await measureHap(hapPath);
  if (!equal(artifact.component, source.component)) fail('artifact metadata differs from prepared ordinary source');
  if (!equal(separateGeneratedBuildInputs(await snapshotHarmonyMirrorSource(workspace), source), prepared)
    || !equal(await snapshotHarmonyMirrorSource(sourceDirectory), source)) fail('source or generated build inputs changed while measuring the artifact');
  const manifest = { schemaVersion: 1, kind: 'ordinary-mirror-artifact-provenance', origin,
    sourceTreeSha256: source.sourceTreeSha256, api: source.api, abi: source.abi, artifact, generatedBuildInputs: prepared.generatedBuildInputs,
    signature: 'unverified', scope: MANIFEST_SCOPE };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

export async function verifyHarmonyMirrorArtifact({ sourceDirectory, resourcesDirectory, expectedOrigin }) {
  if (!expectedOrigin) fail('verification requires the current CI identity');
  const directory = await lstat(resourcesDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('resources must be a real directory');
  const manifest = await jsonFile(join(resourcesDirectory, ARTIFACT_FILE));
  const keys = ['schemaVersion', 'kind', 'origin', 'sourceTreeSha256', 'api', 'abi', 'artifact', 'generatedBuildInputs', 'signature', 'scope'].sort();
  if (!equal(Object.keys(manifest).sort(), keys) || manifest.schemaVersion !== 1 || manifest.kind !== 'ordinary-mirror-artifact-provenance'
    || manifest.signature !== 'unverified' || manifest.scope !== MANIFEST_SCOPE) fail('unsupported or misleading manifest');
  if (!Array.isArray(manifest.generatedBuildInputs) || manifest.generatedBuildInputs.length > GENERATED_LOCKS.length
    || new Set(manifest.generatedBuildInputs.map(file => file?.path)).size !== manifest.generatedBuildInputs.length
    || manifest.generatedBuildInputs.some(file => !file || !equal(Object.keys(file).sort(), ['path', 'sha256', 'size'])
      || !GENERATED_LOCKS.includes(file.path) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 16 * 1024 * 1024
      || !/^[0-9a-f]{64}$/.test(file.sha256 ?? ''))) fail('unsupported generated build-input measurements');
  if (!equal(manifest.origin, expectedOrigin)) fail('artifact is from a different repository, commit, workflow, run or attempt');
  const [source, artifact] = await Promise.all([snapshotHarmonyMirrorSource(sourceDirectory), measureHap(join(resourcesDirectory, 'OHScrcpyServer.hap'))]);
  if (manifest.generatedBuildInputs.some(file => source.files.some(original => original.path === file.path))) fail('committed lock files cannot be relabeled as generated build inputs');
  if (manifest.sourceTreeSha256 !== source.sourceTreeSha256 || manifest.api !== source.api || manifest.abi !== source.abi) fail('manifest is stale for the ordinary source');
  if (!equal(artifact.component, source.component) || !equal(manifest.artifact, artifact)) fail('artifact SHA, size or package metadata does not match the manifest and source');
  return manifest;
}
