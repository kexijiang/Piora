import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';
import { ARTIFACT_FILE, PREPARATION_FILE, readGitHubBuildOrigin, recordHarmonyMirrorArtifact,
  snapshotHarmonyMirrorSource, verifyHarmonyMirrorArtifact, writeMirrorPreparation } from './harmony-mirror-provenance.mjs';

const repositorySource = fileURLToPath(new URL('../third_party/harmony-mirror/', import.meta.url));
const origin = { repository: 'example/Piora', commit: 'a'.repeat(40), runId: '42', runAttempt: '1',
  workflowRef: 'example/Piora/.github/workflows/harmony-preview.yml@refs/tags/v0.5.5-beta.1' };

function initializeTemporaryGit(root) {
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Contract Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'provenance fixture'], { cwd: root, windowsHide: true });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'piora-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source'), workspace = join(root, 'workspace'), resourcesDirectory = join(root, 'resources');
  await cp(repositorySource, sourceDirectory, { recursive: true });
  await cp(sourceDirectory, workspace, { recursive: true });
  await mkdir(resourcesDirectory);
  await writeMirrorPreparation(workspace, sourceDirectory, origin);
  const hapPath = join(workspace, 'entry/build/default/outputs/default/entry-default-signed.hap');
  await mkdir(join(workspace, 'entry/build/default/outputs/default'), { recursive: true });
  const app = JSON.parse(await readFile(join(sourceDirectory, 'AppScope/app.json5'), 'utf8')).app;
  const moduleInfo = JSON.parse(await readFile(join(sourceDirectory, 'entry/src/main/module.json5'), 'utf8')).module;
  const metadata = { app: { ...app, minAPIVersion: 260000026, targetAPIVersion: 260000026,
    compileSdkType: 'HarmonyOS', compileSdkVersion: '26.0.0.23', buildMode: 'release', debug: false }, module: moduleInfo };
  async function writeHap(update = () => {}, extras = {}) {
    const current = structuredClone(metadata); update(current);
    const zip = new JSZip();
    zip.file('module.json', JSON.stringify(current));
    // Deliberately a metadata/hash contract fixture, never an SDK/signing proof.
    zip.file('libs/arm64-v8a/libscrcpy_capture.so', 'synthetic ordinary capture payload');
    for (const [name, bytes] of Object.entries(extras)) zip.file(name, bytes);
    await writeFile(hapPath, await zip.generateAsync({ type: 'nodebuffer' }));
  }
  const manifestPath = join(resourcesDirectory, ARTIFACT_FILE);
  async function record() {
    const result = await recordHarmonyMirrorArtifact({ workspace, sourceDirectory, hapPath, manifestPath, origin });
    await cp(hapPath, join(resourcesDirectory, 'OHScrcpyServer.hap'));
    return result;
  }
  const verify = expectedOrigin => verifyHarmonyMirrorArtifact({ sourceDirectory, resourcesDirectory, expectedOrigin: expectedOrigin ?? origin });
  await writeHap();
  return { root, sourceDirectory, workspace, resourcesDirectory, hapPath, manifestPath, metadata, writeHap, record, verify };
}

test('prepare measures exact copied source and records provenance without claiming build or signature acceptance', async t => {
  const f = await fixture(t);
  const source = await snapshotHarmonyMirrorSource(f.sourceDirectory);
  const receipt = JSON.parse(await readFile(join(f.workspace, PREPARATION_FILE), 'utf8'));
  assert.equal(receipt.sourceTreeSha256, source.sourceTreeSha256);
  assert.deepEqual(receipt.files, source.files);
  assert.deepEqual(receipt.origin, origin);
  const result = await f.record();
  assert.deepEqual(await f.verify(), result);
  assert.equal(result.signature, 'unverified');
  assert.match(result.scope, /does not prove SDK compilation/);
  await assert.rejects(f.record(), error => error.code === 'EEXIST');
});

test('missing manifest and a fabricated signing-passed flag cannot silently allow packaging', async t => {
  const f = await fixture(t);
  await cp(f.hapPath, join(f.resourcesDirectory, 'OHScrcpyServer.hap'));
  await assert.rejects(f.verify(), /required JSON harmony-mirror-manifest.json.*ENOENT/);
  await f.record();
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  manifest.signature = 'verified';
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.verify(), /unsupported or misleading manifest/);
});

test('a changed or additional prepared source file invalidates the preparation receipt', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'entry/src/main/cpp/TcpServer.cpp'), '// source changed');
  await assert.rejects(f.record(), /source receipt, current source or CI identity changed/);
  await cp(join(f.sourceDirectory, 'entry/src/main/cpp/TcpServer.cpp'), join(f.workspace, 'entry/src/main/cpp/TcpServer.cpp'));
  await writeFile(join(f.workspace, 'unexpected-native.cpp'), '// omitted source would be unsafe');
  await assert.rejects(f.record(), /source receipt, current source or CI identity changed/);
});

test('new ohpm lock outputs are measured separately while committed locks stay protected by the source hash', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'entry/oh-package-lock.json5'), '{"fixture":"generated dependency resolution"}');
  const manifest = await f.record();
  assert.deepEqual(manifest.generatedBuildInputs.map(file => file.path), ['entry/oh-package-lock.json5']);
  assert.match(manifest.generatedBuildInputs[0].sha256, /^[0-9a-f]{64}$/);
  await f.verify();
  const other = await fixture(t);
  const committed = '{"fixture":"committed resolution"}';
  await writeFile(join(other.sourceDirectory, 'entry/oh-package-lock.json5'), committed);
  await writeFile(join(other.workspace, 'entry/oh-package-lock.json5'), committed);
  await rm(join(other.workspace, PREPARATION_FILE));
  await writeMirrorPreparation(other.workspace, other.sourceDirectory, origin);
  await writeFile(join(other.workspace, 'entry/oh-package-lock.json5'), '{"fixture":"changed resolution"}');
  await assert.rejects(other.record(), /source receipt, current source or CI identity changed/);
});

test('repository source edits after recording invalidate a matching HAP hash', async t => {
  const f = await fixture(t); await f.record();
  await writeFile(join(f.sourceDirectory, 'entry/src/main/cpp/TcpServer.cpp'), '// different source');
  await assert.rejects(f.verify(), /manifest is stale/);
});

test('artifact bytes and manifest hash are measured independently', async t => {
  const f = await fixture(t); const manifest = await f.record();
  await f.writeHap(() => {}, { 'unrecorded.txt': 'different artifact with identical metadata' });
  await cp(f.hapPath, join(f.resourcesDirectory, 'OHScrcpyServer.hap'));
  await assert.rejects(f.verify(), /artifact SHA, size or package metadata/);
  await f.writeHap(); await cp(f.hapPath, join(f.resourcesDirectory, 'OHScrcpyServer.hap'));
  manifest.artifact.sha256 = 'b'.repeat(64);
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.verify(), /artifact SHA, size or package metadata/);
});

test('same-run identity fences repository, commit, workflow, run and rerun attempts', async t => {
  const f = await fixture(t); await f.record();
  for (const [key, value] of Object.entries({ repository: 'other/Piora', commit: 'b'.repeat(40), runId: '43', runAttempt: '2', workflowRef: 'example/Piora/.github/workflows/release.yml@refs/tags/v0.5.5' })) {
    await assert.rejects(f.verify({ ...origin, [key]: value }), /different repository, commit, workflow, run or attempt/);
  }
  await assert.rejects(recordHarmonyMirrorArtifact({ workspace: f.workspace, sourceDirectory: f.sourceDirectory,
    hapPath: f.hapPath, manifestPath: join(f.root, 'other-manifest.json'), origin: { ...origin, runId: '43' } }), /CI identity changed/);
});

test('real old bundled 1.0.3 cannot be assigned ordinary-source provenance', async t => {
  const f = await fixture(t);
  await cp(fileURLToPath(new URL('../third_party/harmony-tools/windows-x64/OHScrcpyServer.hap', import.meta.url)), f.hapPath);
  await assert.rejects(f.record(), /unsupported ordinary package|not the ordinary capture/);
});

test('a same-version HAP with altered API, mode, entry, permissions, background contract or version is rejected', async t => {
  const f = await fixture(t);
  const mutations = [
    j => { j.app.minAPIVersion = 250000025; },
    j => { j.app.targetAPIVersion = 270000027; },
    j => { j.app.buildMode = 'debug'; },
    j => { j.app.debug = true; },
    j => { j.module.mainElement = 'OtherAbility'; },
    j => { j.module.requestPermissions.push({ name: 'ohos.permission.CAPTURE_SCREEN' }); },
    j => { j.module.abilities[0].backgroundModes = []; },
    j => { j.app.versionName = '1.0.3'; j.app.versionCode = 1000003; },
  ];
  for (const mutation of mutations) {
    await f.writeHap(mutation);
    await assert.rejects(f.record(), /ordinary|release build|metadata differs/);
  }
});

test('HAP metadata is re-read at packaging rather than trusting the manifest declaration', async t => {
  const f = await fixture(t); const manifest = await f.record();
  await f.writeHap(j => { j.app.versionName = '1.0.3'; j.app.versionCode = 1000003; });
  const wrongHap = await readFile(f.hapPath);
  const { createHash } = await import('node:crypto');
  manifest.artifact.sha256 = createHash('sha256').update(wrongHap).digest('hex');
  manifest.artifact.size = wrongHap.length;
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await cp(f.hapPath, join(f.resourcesDirectory, 'OHScrcpyServer.hap'));
  await assert.rejects(f.verify(), /artifact SHA, size or package metadata/);
});

test('known debug acceptance payload and oversized root metadata fail before recording', async t => {
  const f = await fixture(t);
  await f.writeHap(() => {}, { 'ets/modules.abc': 'private AtlasFixture debug input' });
  await assert.rejects(f.record(), /debug acceptance symbols/);
  await f.writeHap(() => {}, { 'libs/x86/libscrcpy_capture.so': 'foreign ABI' });
  await assert.rejects(f.record(), /unexpected native ABI/);
  await f.writeHap(j => { j.app.extra = 'x'.repeat(600 * 1024); });
  await assert.rejects(f.record(), /metadata is invalid or exceeds limit/);
});

test('recording only accepts the prepared entry/default output and keeps unsigned artifacts out', async t => {
  const f = await fixture(t);
  const unsigned = join(f.workspace, 'entry/build/default/outputs/default/entry-default-unsigned.hap');
  await cp(f.hapPath, unsigned);
  for (const hapPath of [unsigned, join(f.root, 'foreign-signed.hap')]) {
    if (hapPath.endsWith('foreign-signed.hap')) await cp(f.hapPath, hapPath);
    await assert.rejects(recordHarmonyMirrorArtifact({ workspace: f.workspace, sourceDirectory: f.sourceDirectory,
      hapPath, manifestPath: f.manifestPath, origin }), /current workspace entry\/default signed output/);
  }
});

test('source junctions and a build-output junction resolving outside the workspace are rejected', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await cp(f.hapPath, join(outside, 'entry-default-signed.hap'));
  await symlink(outside, join(f.sourceDirectory, 'unexpected-linked-source'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotHarmonyMirrorSource(f.sourceDirectory), /symlink/);
  await rm(join(f.sourceDirectory, 'unexpected-linked-source'));
  const output = join(f.workspace, 'entry/build/default/outputs/default');
  await rm(output, { recursive: true });
  await symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.record(), /artifact resolves outside/);
});

test('local receipts cannot be converted into current-CI provenance', async t => {
  const f = await fixture(t);
  const receiptPath = join(f.workspace, PREPARATION_FILE);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.origin = null; await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(f.record(), /CI identity changed/);
});

test('GitHub identity requires complete current checkout information and rejects a different HEAD', async t => {
  const root = await mkdtemp(join(tmpdir(), 'piora-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = initializeTemporaryGit(root);
  const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: origin.repository, GITHUB_SHA: commit,
    GITHUB_RUN_ID: origin.runId, GITHUB_RUN_ATTEMPT: origin.runAttempt, GITHUB_WORKFLOW_REF: origin.workflowRef };
  assert.deepEqual(readGitHubBuildOrigin(root, environment), { ...origin, commit });
  assert.throws(() => readGitHubBuildOrigin(root, {}), /requires a GitHub Actions/);
  assert.throws(() => readGitHubBuildOrigin(root, { ...environment, GITHUB_RUN_ATTEMPT: undefined }), /incomplete/);
  assert.throws(() => readGitHubBuildOrigin(root, { ...environment, GITHUB_SHA: 'b'.repeat(40) }), /checkout commit differs/);
});

test('the actual beforeBuild hook rejects the shipped old resource before release-note or packaging work', async t => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const f = await fixture(t);
  const commit = initializeTemporaryGit(f.root);
  const resourceDirectory = join(f.root, 'third_party/harmony-tools/windows-x64');
  await mkdir(resourceDirectory, { recursive: true });
  await cp(fileURLToPath(new URL('../third_party/harmony-tools/windows-x64/OHScrcpyServer.hap', import.meta.url)), join(resourceDirectory, 'OHScrcpyServer.hap'));
  const environment = { ...process.env, PIORA_REQUIRE_HARMONY_RELEASE_RESOURCE: '1', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: origin.repository, GITHUB_SHA: commit,
    GITHUB_RUN_ID: origin.runId, GITHUB_RUN_ATTEMPT: origin.runAttempt, GITHUB_WORKFLOW_REF: origin.workflowRef };
  const code = `import hook from './scripts/electron-before-build.cjs';
    try { await hook({appDir:${JSON.stringify(join(f.root, 'desktop'))},electronPlatformName:'win32'}); process.exitCode=2; }
    catch(error) { if(!/required JSON harmony-mirror-manifest.json.*ENOENT/.test(error.message)) throw error; console.log('Old resource blocked before packaging'); }`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: projectRoot, env: environment, encoding: 'utf8', windowsHide: true });
  assert.match(output, /Old resource blocked before packaging/);
});
