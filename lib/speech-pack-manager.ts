import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as tar from "tar";
import {
  detectSpeechHardware,
  getSpeechRuntimeSource,
  SENSEVOICE_MODEL_SOURCE,
  SENSEVOICE_TOKENS_SOURCE,
  SHERPA_NODE_SOURCE,
  SPEECH_PACK_APPROXIMATE_DOWNLOAD_BYTES,
  SPEECH_PACK_VERSION,
  speechRuntimeKey,
  type SpeechDownloadSource,
  type SpeechRuntimeSource,
} from "./speech-pack-catalog";
import { readSpeechSettings, writeSpeechSettings, type SpeechSettings } from "./speech-settings";
import { matchManualSpeechSourceName } from "./speech-manual-file";
import {
  LOCAL_SPEECH_PACK_ID,
  type SpeechInstallState,
  type SpeechStatus,
} from "./speech-types";

const PACK_DIRECTORY_NAME = `${LOCAL_SPEECH_PACK_ID}-${SPEECH_PACK_VERSION}`;
const STAGING_DIRECTORY_NAME = `.${PACK_DIRECTORY_NAME}.staging`;
const MANIFEST_NAME = "manifest.json";
const MANUAL_DIRECTORY_NAME = `.manual-${PACK_DIRECTORY_NAME}-${speechRuntimeKey()}`;
const MAX_MANUAL_SOURCE_BYTES = 320 * 1024 * 1024;

interface InstalledSpeechManifest {
  schema: "piora-local-speech-pack-v1";
  packId: typeof LOCAL_SPEECH_PACK_ID;
  version: string;
  engine: "sherpa-onnx";
  platformKey: string;
  runtimePackage: string;
  installedBytes: number;
  installedAt: string;
  sources: Array<{ name: string; algorithm: string; digest: string }>;
}

interface SpeechInstallGlobal {
  state: SpeechInstallState;
  running: Promise<void> | null;
}

type SpeechInstallGlobalThis = typeof globalThis & {
  __pioraSpeechPackInstall?: SpeechInstallGlobal;
};

function newInstallState(phase: SpeechInstallState["phase"] = "idle"): SpeechInstallState {
  return {
    phase,
    downloadedBytes: 0,
    totalBytes: SPEECH_PACK_APPROXIMATE_DOWNLOAD_BYTES,
    updatedAt: new Date().toISOString(),
  };
}

function installGlobal(): SpeechInstallGlobal {
  const target = globalThis as SpeechInstallGlobalThis;
  target.__pioraSpeechPackInstall ??= { state: newInstallState(), running: null };
  return target.__pioraSpeechPackInstall;
}

function updateInstallState(update: Partial<SpeechInstallState>): void {
  const global = installGlobal();
  global.state = {
    ...global.state,
    ...update,
    updatedAt: new Date().toISOString(),
  };
}

export function speechPackPath(settings: Pick<SpeechSettings, "packDirectory">): string {
  return resolve(settings.packDirectory, PACK_DIRECTORY_NAME);
}

function assertManagedChild(root: string, path: string): void {
  if (dirname(resolve(path)) !== resolve(root)) {
    throw new Error("Refusing to modify a path outside the speech pack directory");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isSpeechStagingDirectory(name: string): boolean {
  return name === STAGING_DIRECTORY_NAME
    || (name.startsWith(`.${PACK_DIRECTORY_NAME}.`) && name.endsWith(".staging"));
}

async function resumableStagingBytes(path: string, runtimeSource: SpeechRuntimeSource): Promise<number> {
  const candidates = [
    join(path, "downloads", SHERPA_NODE_SOURCE.name),
    join(path, "downloads", `${SHERPA_NODE_SOURCE.name}.partial`),
    join(path, "downloads", runtimeSource.name),
    join(path, "downloads", `${runtimeSource.name}.partial`),
    join(path, "model", SENSEVOICE_MODEL_SOURCE.name),
    join(path, "model", `${SENSEVOICE_MODEL_SOURCE.name}.partial`),
    join(path, "model", SENSEVOICE_TOKENS_SOURCE.name),
    join(path, "model", `${SENSEVOICE_TOKENS_SOURCE.name}.partial`),
  ];
  let bytes = 0;
  for (const candidate of candidates) {
    try { bytes += (await stat(candidate)).size; } catch { /* This source has not started yet. */ }
  }
  return bytes;
}

async function prepareInstallStaging(root: string, runtimeSource: SpeechRuntimeSource): Promise<string> {
  const preferred = join(root, STAGING_DIRECTORY_NAME);
  assertManagedChild(root, preferred);
  if (await pathExists(preferred)) return preferred;

  const entries = await readdir(root, { withFileTypes: true });
  const legacy = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isSpeechStagingDirectory(entry.name))
    .map(async (entry) => {
      const path = join(root, entry.name);
      return { path, bytes: await resumableStagingBytes(path, runtimeSource) };
    }));
  legacy.sort((left, right) => right.bytes - left.bytes);
  for (const candidate of legacy) {
    try {
      await rename(candidate.path, preferred);
      return preferred;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return preferred;
    }
  }
  return preferred;
}

async function removeAbandonedSpeechStaging(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isSpeechStagingDirectory(entry.name))
    .map(async (entry) => {
      const path = join(root, entry.name);
      assertManagedChild(root, path);
      await rm(path, { recursive: true, force: true });
    }));
}

async function readInstalledManifest(packPath: string): Promise<InstalledSpeechManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(packPath, MANIFEST_NAME), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const manifest = parsed as Partial<InstalledSpeechManifest>;
    if (
      manifest.schema !== "piora-local-speech-pack-v1"
      || manifest.packId !== LOCAL_SPEECH_PACK_ID
      || manifest.version !== SPEECH_PACK_VERSION
      || manifest.engine !== "sherpa-onnx"
      || manifest.platformKey !== speechRuntimeKey()
      || typeof manifest.runtimePackage !== "string"
      || typeof manifest.installedBytes !== "number"
    ) return null;

    const required = [
      join(packPath, "model", "model.int8.onnx"),
      join(packPath, "model", "tokens.txt"),
      join(packPath, "runtime", "package.json"),
      join(packPath, "runtime", "node_modules", "sherpa-onnx-node", "package.json"),
      join(packPath, "runtime", "node_modules", manifest.runtimePackage, "package.json"),
    ];
    if (!(await Promise.all(required.map(pathExists))).every(Boolean)) return null;
    return manifest as InstalledSpeechManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function getSpeechStatus(): Promise<SpeechStatus> {
  const settings = await readSpeechSettings();
  const packPath = speechPackPath(settings);
  const manifest = await readInstalledManifest(packPath);
  const hardware = detectSpeechHardware();
  return {
    enabled: settings.enabled,
    available: settings.enabled && manifest !== null && hardware.supported,
    installed: manifest !== null,
    engine: "sherpa-onnx",
    model: "SenseVoiceSmall INT8",
    packId: LOCAL_SPEECH_PACK_ID,
    packVersion: SPEECH_PACK_VERSION,
    packDirectory: settings.packDirectory,
    packPath,
    approximateDownloadBytes: SPEECH_PACK_APPROXIMATE_DOWNLOAD_BYTES,
    installedBytes: manifest?.installedBytes ?? null,
    languages: ["zh", "en", "yue", "ja", "ko"],
    hardware,
    install: { ...installGlobal().state },
  };
}

function digestMatches(source: SpeechDownloadSource, digest: Buffer): boolean {
  return encodeDigest(source, digest) === source.digest;
}

function encodeDigest(source: SpeechDownloadSource, digest: Buffer): string {
  return source.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
}

function requiredSpeechSources(): SpeechDownloadSource[] {
  const runtimeSource = getSpeechRuntimeSource();
  return runtimeSource
    ? [SHERPA_NODE_SOURCE, runtimeSource, SENSEVOICE_MODEL_SOURCE, SENSEVOICE_TOKENS_SOURCE]
    : [];
}

function manualSpeechPackDirectory(settings: Pick<SpeechSettings, "packDirectory">): string {
  return join(resolve(settings.packDirectory), MANUAL_DIRECTORY_NAME);
}

async function verifySpeechSourceFile(source: SpeechDownloadSource, path: string): Promise<boolean> {
  try {
    const hash = createHash(source.algorithm);
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return digestMatches(source, hash.digest());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function getManualSpeechPackState(): Promise<{
  version: string;
  platformKey: string;
  sources: Array<{
    name: string;
    url: string;
    uploaded: boolean;
    algorithm: SpeechDownloadSource["algorithm"];
    digest: string;
    expectedBytes: number | null;
  }>;
  complete: boolean;
}> {
  const settings = await readSpeechSettings();
  const directory = manualSpeechPackDirectory(settings);
  const sources = await Promise.all(requiredSpeechSources().map(async (source) => ({
    name: source.name,
    url: source.url,
    uploaded: await pathExists(join(directory, source.name)),
    algorithm: source.algorithm,
    digest: source.digest,
    expectedBytes: "bytes" in source && typeof source.bytes === "number" ? source.bytes : null,
  })));
  return {
    version: SPEECH_PACK_VERSION,
    platformKey: speechRuntimeKey(),
    sources,
    complete: sources.length > 0 && sources.every((source) => source.uploaded),
  };
}

export async function storeManualSpeechPackSource(
  requestedName: string,
  body: ReadableStream<Uint8Array> | null,
  declaredBytes?: number,
): Promise<Awaited<ReturnType<typeof getManualSpeechPackState>>> {
  const sources = requiredSpeechSources();
  const resolvedName = matchManualSpeechSourceName(requestedName, sources.map((source) => source.name));
  const source = sources.find((candidate) => candidate.name === resolvedName);
  if (!source) throw new Error("This file does not belong to the current speech pack");
  if (!body) throw new Error("The uploaded speech-pack file is empty");
  if (declaredBytes !== undefined && (!Number.isFinite(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_MANUAL_SOURCE_BYTES)) {
    throw new Error("The uploaded speech-pack file is too large");
  }
  const settings = await readSpeechSettings();
  const root = resolve(settings.packDirectory);
  const directory = manualSpeechPackDirectory(settings);
  assertManagedChild(root, directory);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, source.name);
  const temporary = `${destination}.${randomUUID()}.partial`;
  const reader = body.getReader();
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash(source.algorithm);
  let receivedBytes = 0;
  let streamError: unknown;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_MANUAL_SOURCE_BYTES) throw new Error("The uploaded speech-pack file is too large");
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    streamError = error;
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  if (streamError) {
    await rm(temporary, { force: true }).catch(() => {});
    throw streamError;
  }
  const digest = hash.digest();
  if (!digestMatches(source, digest)) {
    await rm(temporary, { force: true });
    const expectedBytes = "bytes" in source && typeof source.bytes === "number"
      ? `; expected ${source.bytes} bytes`
      : "";
    throw new Error(
      `Checksum verification failed for ${source.name}: expected ${source.algorithm} ${source.digest}, received ${encodeDigest(source, digest)}; received ${receivedBytes} bytes${expectedBytes}`,
    );
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return getManualSpeechPackState();
}

export async function downloadVerified(source: SpeechDownloadSource, destination: string): Promise<void> {
  updateInstallState({ currentFile: source.name });
  const temporary = `${destination}.partial`;
  if (await verifySpeechSourceFile(source, destination)) {
    const completedBytes = (await stat(destination)).size;
    updateInstallState({
      downloadedBytes: Math.min(
        installGlobal().state.totalBytes,
        installGlobal().state.downloadedBytes + completedBytes,
      ),
    });
    return;
  }
  await rm(destination, { force: true });

  if (await verifySpeechSourceFile(source, temporary)) {
    const completedBytes = (await stat(temporary)).size;
    await rename(temporary, destination);
    updateInstallState({
      downloadedBytes: Math.min(
        installGlobal().state.totalBytes,
        installGlobal().state.downloadedBytes + completedBytes,
      ),
    });
    return;
  }

  try {
    const partialBytes = (await stat(temporary)).size;
    if ("bytes" in source && typeof source.bytes === "number" && partialBytes >= source.bytes) {
      // A full-sized file that failed the checksum cannot be repaired by Range.
      await rm(temporary, { force: true });
    } else {
    updateInstallState({
      downloadedBytes: Math.min(
        installGlobal().state.totalBytes,
        installGlobal().state.downloadedBytes + partialBytes,
      ),
    });
    }
  } catch { /* Start without a resumable partial. */ }
  let lastError: unknown;
  const urls = [source.url, ...(source.fallbackUrls ?? []), ...(source.url.startsWith("https://registry.npmjs.org/") ? [source.url.replace("https://registry.npmjs.org/", "https://registry.npmmirror.com/")] : [])];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(new Error("下载连接超时")), 20_000);
    try {
      let existingBytes = 0;
      try { existingBytes = (await stat(temporary)).size; } catch { /* Start a new partial download. */ }
      const response = await fetch(urls[(attempt - 1) % urls.length], {
        signal: controller.signal,
        cache: "no-store",
        redirect: "follow",
        ...(existingBytes > 0 ? { headers: { range: `bytes=${existingBytes}-` } } : {}),
      });
      if ((!response.ok && response.status !== 206) || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const append = existingBytes > 0 && response.status === 206;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
        if (!range || Number(range[1]) !== existingBytes) throw new Error("下载服务器返回了错误的续传位置");
      }
      if (!append && existingBytes > 0) {
        const global = installGlobal();
        updateInstallState({ downloadedBytes: Math.max(0, global.state.downloadedBytes - existingBytes) });
        existingBytes = 0;
      }
      const hash = createHash(source.algorithm);
      if (append) {
        for await (const chunk of createReadStream(temporary)) hash.update(chunk as Buffer);
      }
      const handle = await open(temporary, append ? "a" : "w", 0o600);
      const reader = response.body.getReader();
      try {
        while (true) {
          clearTimeout(timeout);
          timeout = setTimeout(() => controller.abort(new Error("下载停滞，已保留续传进度")), 30_000);
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          let offset = 0;
          while (offset < value.byteLength) {
            const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
            if (!bytesWritten) throw new Error("无法继续写入离线包");
            offset += bytesWritten;
          }
          const global = installGlobal();
          updateInstallState({
            downloadedBytes: Math.min(
              global.state.totalBytes,
              global.state.downloadedBytes + value.byteLength,
            ),
          });
        }
      } finally {
        reader.releaseLock();
        await handle.close();
      }
      const digest = hash.digest();
      if (!digestMatches(source, digest)) throw new Error("checksum mismatch");
      await rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === "checksum mismatch") {
        try {
          const invalidBytes = (await stat(temporary)).size;
          const global = installGlobal();
          updateInstallState({ downloadedBytes: Math.max(0, global.state.downloadedBytes - invalidBytes) });
          await rm(temporary, { force: true });
        } catch { /* The partial file may already be gone. */ }
      }
      if (attempt < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  const cause = lastError && typeof lastError === "object" && "cause" in lastError
    ? (lastError as { cause?: { code?: unknown; message?: unknown } }).cause
    : undefined;
  const detail = typeof cause?.code === "string"
    ? cause.code
    : lastError instanceof Error
      ? lastError.message
      : "unknown error";
  throw new Error(`无法下载 ${source.name}（${detail}）。已尝试备用下载源并保留续传进度，重试可继续；也可在离线包设置中导入文件。`);
}

function archiveEntryIsSafe(path: string, entryType: unknown): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  if (normalized.split("/").some((part) => part === "..")) return false;
  return entryType !== "SymbolicLink" && entryType !== "Link";
}

async function extractRuntimeArchive(
  archive: string,
  runtimeRoot: string,
  source: SpeechRuntimeSource,
): Promise<void> {
  const destination = join(runtimeRoot, "node_modules", source.packageName);
  await mkdir(destination, { recursive: true });
  await tar.x({
    file: archive,
    cwd: destination,
    strip: 1,
    preservePaths: false,
    filter: (path, entry) => archiveEntryIsSafe(path, (entry as { type?: unknown }).type),
  });
}

async function installSpeechPack(settings: SpeechSettings, manualDirectory?: string): Promise<void> {
  const runtimeSource = getSpeechRuntimeSource();
  if (!runtimeSource) {
    throw new Error(`Local speech is not available for ${process.platform}/${process.arch}`);
  }
  const root = resolve(settings.packDirectory);
  const target = speechPackPath(settings);
  assertManagedChild(root, target);
  if (await readInstalledManifest(target)) {
    await removeAbandonedSpeechStaging(root);
    return;
  }

  await mkdir(root, { recursive: true });
  const staging = await prepareInstallStaging(root, runtimeSource);
  const backup = join(root, `.${PACK_DIRECTORY_NAME}.${randomUUID()}.backup`);
  assertManagedChild(root, staging);
  assertManagedChild(root, backup);
  const downloads = join(staging, "downloads");
  const modelRoot = join(staging, "model");
  const runtimeRoot = join(staging, "runtime");
  await mkdir(downloads, { recursive: true });
  await mkdir(modelRoot, { recursive: true });
  await mkdir(join(runtimeRoot, "node_modules"), { recursive: true });

  let movedOldPack = false;
  try {
    const nodeArchive = join(downloads, SHERPA_NODE_SOURCE.name);
    const platformArchive = join(downloads, runtimeSource.name);
    const stageSource = async (source: SpeechDownloadSource, destination: string) => {
      if (!manualDirectory) return downloadVerified(source, destination);
      const localSource = join(manualDirectory, source.name);
      if (!(await verifySpeechSourceFile(source, localSource))) {
        throw new Error(`Checksum verification failed for ${source.name}`);
      }
      await copyFile(localSource, destination);
    };
    await stageSource(SHERPA_NODE_SOURCE, nodeArchive);
    await stageSource(runtimeSource, platformArchive);
    await stageSource(SENSEVOICE_MODEL_SOURCE, join(modelRoot, SENSEVOICE_MODEL_SOURCE.name));
    await stageSource(SENSEVOICE_TOKENS_SOURCE, join(modelRoot, SENSEVOICE_TOKENS_SOURCE.name));

    updateInstallState({ phase: "installing", currentFile: undefined });
    await extractRuntimeArchive(nodeArchive, runtimeRoot, SHERPA_NODE_SOURCE);
    await extractRuntimeArchive(platformArchive, runtimeRoot, runtimeSource);
    await writeFile(join(runtimeRoot, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
    await rm(downloads, { recursive: true, force: true });

    const installedBytes = SENSEVOICE_MODEL_SOURCE.bytes
      + SENSEVOICE_TOKENS_SOURCE.bytes
      + SHERPA_NODE_SOURCE.unpackedBytes
      + runtimeSource.unpackedBytes;
    const manifest: InstalledSpeechManifest = {
      schema: "piora-local-speech-pack-v1",
      packId: LOCAL_SPEECH_PACK_ID,
      version: SPEECH_PACK_VERSION,
      engine: "sherpa-onnx",
      platformKey: speechRuntimeKey(),
      runtimePackage: runtimeSource.packageName,
      installedBytes,
      installedAt: new Date().toISOString(),
      sources: [SHERPA_NODE_SOURCE, runtimeSource, SENSEVOICE_MODEL_SOURCE, SENSEVOICE_TOKENS_SOURCE]
        .map((source) => ({ name: source.name, algorithm: source.algorithm, digest: source.digest })),
    };
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (await pathExists(target)) {
      await rename(target, backup);
      movedOldPack = true;
    }
    await rename(staging, target);
    if (movedOldPack) await rm(backup, { recursive: true, force: true });
    if (manualDirectory) await rm(manualDirectory, { recursive: true, force: true });
    await removeAbandonedSpeechStaging(root);
  } catch (error) {
    if (movedOldPack && !(await pathExists(target)) && await pathExists(backup)) {
      await rename(backup, target).catch(() => {});
    }
    // Keep verified files and partial downloads so a later retry can resume.
    throw error;
  }
}

export function startSpeechPackInstall(): SpeechInstallState {
  const global = installGlobal();
  if (global.running) return { ...global.state };
  updateInstallState(newInstallState("downloading"));
  global.running = readSpeechSettings()
    .then(installSpeechPack)
    .then(() => {
      updateInstallState({
        phase: "complete",
        currentFile: undefined,
        error: undefined,
        downloadedBytes: installGlobal().state.totalBytes,
      });
    })
    .catch((error: unknown) => {
      updateInstallState({
        phase: "error",
        currentFile: undefined,
        error: error instanceof Error ? error.message : "Speech pack installation failed",
      });
    })
    .finally(() => {
      installGlobal().running = null;
    });
  return { ...global.state };
}

export function startManualSpeechPackInstall(): SpeechInstallState {
  const global = installGlobal();
  if (global.running) return { ...global.state };
  updateInstallState(newInstallState("installing"));
  global.running = readSpeechSettings()
    .then(async (settings) => {
      const directory = manualSpeechPackDirectory(settings);
      const state = await getManualSpeechPackState();
      if (!state.complete) throw new Error("Add all required speech-pack files before installing");
      await installSpeechPack(settings, directory);
    })
    .then(() => {
      updateInstallState({
        phase: "complete",
        currentFile: undefined,
        error: undefined,
        downloadedBytes: installGlobal().state.totalBytes,
      });
    })
    .catch((error: unknown) => {
      updateInstallState({
        phase: "error",
        currentFile: undefined,
        error: error instanceof Error ? error.message : "Speech pack installation failed",
      });
    })
    .finally(() => { installGlobal().running = null; });
  return { ...global.state };
}

export function waitForSpeechPackInstall(): Promise<void> {
  return installGlobal().running ?? Promise.resolve();
}

export async function updateSpeechSettings(input: {
  enabled?: boolean;
  packDirectory?: string | null;
}): Promise<SpeechStatus> {
  const current = await readSpeechSettings();
  const directoryChanged = input.packDirectory !== undefined
    && resolve(input.packDirectory?.trim() || current.packDirectory) !== resolve(current.packDirectory);
  const nextEnabled = directoryChanged ? false : input.enabled ?? current.enabled;
  if (nextEnabled) {
    const packDirectory = input.packDirectory?.trim() || current.packDirectory;
    const manifest = await readInstalledManifest(speechPackPath({ packDirectory }));
    if (!manifest) throw new Error("Download the local speech pack before enabling speech recognition");
  }
  await writeSpeechSettings({
    enabled: nextEnabled,
    packDirectory: input.packDirectory === undefined
      ? (current.customPackDirectory ? current.packDirectory : null)
      : input.packDirectory,
  });
  return getSpeechStatus();
}

export async function removeSpeechPack(): Promise<SpeechStatus> {
  const settings = await readSpeechSettings();
  const target = speechPackPath(settings);
  assertManagedChild(settings.packDirectory, target);
  await writeSpeechSettings({
    enabled: false,
    packDirectory: settings.customPackDirectory ? settings.packDirectory : null,
  });
  await rm(target, { recursive: true, force: true });
  await rm(manualSpeechPackDirectory(settings), { recursive: true, force: true });
  await removeAbandonedSpeechStaging(resolve(settings.packDirectory));
  updateInstallState(newInstallState());
  return getSpeechStatus();
}

export function createExternalSpeechRequire(packPath: string): NodeJS.Require {
  const { createRequire } = process.getBuiltinModule("node:module");
  return createRequire(join(packPath, "runtime", "package.json"));
}

export async function verifiedSpeechPackPath(): Promise<{
  path: string;
  settings: SpeechSettings;
}> {
  const settings = await readSpeechSettings();
  const path = speechPackPath(settings);
  if (!settings.enabled) throw new Error("Local speech recognition is disabled");
  if (!(await readInstalledManifest(path))) throw new Error("Local speech pack is not installed");
  return { path, settings };
}
