import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getRuntimeUserHomeDirectory as homedir } from "../../runtime-home";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import videoBundle from "../../../third_party/harmony-video/manifest.json";
import { readBoundedRegularFile } from "./bounded-file";
import { harmonyRuntimeAsset } from "./asset-path";

const bundledDirectory = () => harmonyRuntimeAsset("node_modules", "hypium-driver", "build", "lib", "resource");
const bundledName = /^libscrcpy_server-(\d+\.\d+(?:\.\d+)?)-\d+\.so$/;
const modernDirectory = () => harmonyRuntimeAsset("third_party", "harmony-video");
export interface DebugVideoLibrary { bytes: Buffer; name: string; sha256: string; source: "bundled" | "installed" }
const selection = (bytes: Buffer, name: string, source: DebugVideoLibrary["source"]): DebugVideoLibrary => ({
  bytes: validateVideoLibrary(bytes), name, sha256: createHash("sha256").update(bytes).digest("hex"), source,
});

/** Only versioned Unix-socket libraries; legacy numbered libraries use another transport. */
export function selectBundledVideoLibrary(names: string[], deviceVersion: string): string | undefined {
  const candidates = names.filter(name => bundledName.test(name));
  const selected = selectVideoLibrary(candidates.map(name => name.replace("libscrcpy_server-", "libscrcpy/libscrcpy_server_unix_").replace(/\.so$/, ".z.so")), deviceVersion);
  return selected?.replace("libscrcpy/libscrcpy_server_unix_", "libscrcpy_server-").replace(/\.z\.so$/, ".so");
}

/** An installed IDE is optional: the existing Hypium dependency carries the same capture protocol. */
export async function findDebugVideoSource(hdcPath: string, findInstalled = findDevEcoVideoJar, resources = bundledDirectory()): Promise<string | undefined> {
  const jar = await findInstalled(hdcPath).catch(() => undefined);
  if (jar) return jar;
  const names = await readdir(resources).catch(() => []);
  if (names.some(name => bundledName.test(name))) return resources;
  return (await lstat(modernDirectory()).catch(() => undefined))?.isDirectory() ? modernDirectory() : undefined;
}

function validateVideoLibrary(bytes: Buffer): Buffer {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183) {
    throw new Error("Debug video library is not a little-endian ARM64 ELF file");
  }
  return bytes;
}

async function readBundledVideoLibrary(resources: string, deviceVersion: string): Promise<DebugVideoLibrary> {
  const name = selectBundledVideoLibrary(await readdir(resources), deviceVersion);
  if (!name) throw new Error("The bundled runtime has no compatible debug video library");
  return selection(await readBoundedRegularFile(join(resources, name), 4 * 1024 * 1024), name, "bundled");
}

export async function readDebugVideoLibrary(source: string, deviceVersion: string): Promise<Buffer> {
  return (await readDebugVideoLibrarySelection(source, deviceVersion)).bytes;
}

export async function readDebugVideoLibrarySelection(source: string, deviceVersion: string): Promise<DebugVideoLibrary> {
  // Select across both sources: an older installed IDE must not hide the newer bundled library.
  const modernName = selectVideoLibrary(videoBundle.assets.map(asset => `libscrcpy/${asset.name}`), deviceVersion)?.split("/").pop();
  const modern = videoBundle.assets.find(asset => asset.name === modernName);
  let primary: DebugVideoLibrary | undefined;
  let primaryError: unknown;
  let directorySource = false;
  try {
    const info = await lstat(source);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      directorySource = true;
      if (source !== modernDirectory()) primary = await readBundledVideoLibrary(source, deviceVersion);
    } else primary = await readDevEcoVideoSelection(source, deviceVersion);
  } catch (error) { primaryError = error; }
  if (primary && (!modern || compareLibraryNames(primary.name, modern.name) >= 0)) return primary;
  if (modern) {
    const result = selection(await readBoundedRegularFile(join(modernDirectory(), modern.name), 4 * 1024 * 1024), modern.name, "bundled");
    if (result.bytes.length !== modern.size || result.sha256 !== modern.sha256) throw new Error("The bundled debug video library failed integrity verification; repair Piora");
    return result;
  }
  if (primary) return primary;
  if (directorySource && primaryError) throw primaryError;
  // Preserve older device support when the selected IDE is missing or unreadable.
  try { return await readBundledVideoLibrary(bundledDirectory(), deviceVersion); }
  catch { throw primaryError ?? new Error("No compatible debug video library is available"); }
}

/** Version numbers select candidates; only the device loader proves ABI support. */
export async function readDebugVideoLibraryCandidates(source: string, deviceVersion: string): Promise<DebugVideoLibrary[]> {
  const preferred = await readDebugVideoLibrarySelection(source, deviceVersion);
  const candidates = [preferred];
  let remaining = videoBundle.assets.map(asset => `libscrcpy/${asset.name}`);
  for (let name = selectVideoLibrary(remaining, deviceVersion); name; name = selectVideoLibrary(remaining, deviceVersion)) {
    remaining = remaining.filter(candidate => candidate !== name);
    const asset = videoBundle.assets.find(asset => `libscrcpy/${asset.name}` === name)!;
    // Never cross ABI families or retry identical bytes under a different name.
    if (version(asset.name) !== version(preferred.name) || candidates.some(candidate => candidate.sha256 === asset.sha256)) continue;
    const result = selection(await readBoundedRegularFile(join(modernDirectory(), asset.name), 4 * 1024 * 1024), asset.name, "bundled");
    if (result.bytes.length !== asset.size || result.sha256 !== asset.sha256) throw new Error("The bundled debug video library failed integrity verification; repair Piora");
    candidates.push(result);
  }
  return candidates;
}

const version = (name: string) => /(?:unix_|server-)(\d+\.\d+(?:\.\d+)?)-/.exec(name)?.[1];
function compareLibraryNames(a: string, b: string): number {
  return version(a)!.localeCompare(version(b)!, undefined, { numeric: true })
    || (/-([0-9]{8})\./.exec(a)?.[1] ?? "").localeCompare(/-([0-9]{8})\./.exec(b)?.[1] ?? "");
}
export function selectVideoLibrary(names: string[], deviceVersion: string): string | undefined {
  const device = /\d+\.\d+(?:\.\d+)?/.exec(deviceVersion)?.[0];
  if (!device) return;
  return names.filter(name => /^libscrcpy\/libscrcpy_server_unix_\d+\.\d+(?:\.\d+)?-\d+\.z\.so$/.test(name))
    .filter(name => version(name)!.localeCompare(device, undefined, { numeric: true }) <= 0)
    // UiTest 7 requires the newer ABI family; do not silently call 6.4 compatible.
    .filter(name => Number(device.split(".")[0]) < 7 || version(name)!.localeCompare("6.6", undefined, { numeric: true }) >= 0)
    .sort((a, b) => compareLibraryNames(b, a))[0];
}

/** Optional local SDK candidate; the pinned redistributable bundle is independent. */
export async function findDevEcoVideoJar(hdcPath: string): Promise<string | undefined> {
  if (!isAbsolute(hdcPath) || !(await lstat(hdcPath).catch(() => undefined))?.isFile()) return;
  const roots: string[] = [];
  let directory = dirname(hdcPath);
  for (let i = 0; i < 7; i++) { roots.push(directory); const parent = dirname(directory); if (parent === directory) break; directory = parent; }
  if (process.env.DEVECO_CLI_STUDIO_PATH) roots.push(process.env.DEVECO_CLI_STUDIO_PATH);
  const huawei = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Huawei");
  for (const name of await readdir(huawei).catch(() => [])) {
    if (/^DevEcoStudio/.test(name)) {
      const root = (await readFile(join(huawei, name, ".home"), "utf8").catch(() => "")).trim();
      if (isAbsolute(root)) roots.push(root);
    }
  }
  for (const root of new Set(roots)) {
    const libs = join(root, "plugins", "screen-mirroring", "lib");
    const names = (await readdir(libs).catch(() => [])).filter(name => /^hosScrcpy-[\w.-]+\.jar$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (names[0]) return join(libs, names[0]);
  }
}

export async function readDevEcoVideoLibrary(jar: string, deviceVersion: string): Promise<Buffer> {
  return (await readDevEcoVideoSelection(jar, deviceVersion)).bytes;
}

async function readDevEcoVideoSelection(jar: string, deviceVersion: string): Promise<DebugVideoLibrary> {
  const zip = await JSZip.loadAsync(await readBoundedRegularFile(jar, 128 * 1024 * 1024));
  const name = selectVideoLibrary(Object.keys(zip.files), deviceVersion);
  const entry = name && zip.file(name);
  if (!entry) throw new Error("This DevEco SDK has no compatible debug video library");
  const stream = (entry as JSZip.JSZipObject & { internalStream(type: "nodebuffer"): JSZip.JSZipStreamHelper<Buffer> }).internalStream("nodebuffer");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let size = 0, failed = false; const chunks: Buffer[] = [];
    stream.on("data", chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { failed = true; stream.pause(); reject(new Error("SDK video library exceeds its size limit")); }
      else if (!failed) chunks.push(chunk);
    });
    stream.on("error", reject); stream.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); }); stream.resume();
  });
  return selection(bytes, name!, "installed");
}
