import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import videoBundle from "../../../third_party/harmony-video/manifest.json";
import { readBoundedRegularFile } from "./bounded-file";
import { harmonyRuntimeAsset } from "./asset-path";

const hypiumDirectory = () => harmonyRuntimeAsset("node_modules", "hypium-driver", "build", "lib", "resource");
const modernDirectory = () => harmonyRuntimeAsset("third_party", "harmony-video");
const hypiumName = /^libscrcpy_server-(\d+\.\d+(?:\.\d+)?)-\d+\.so$/;

export interface BundledVideoLibrary { bytes: Buffer; name: string; sha256: string; source: "bundled" }

function selection(bytes: Buffer, name: string): BundledVideoLibrary {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183) {
    throw new Error("Bundled video library is not a little-endian ARM64 ELF file");
  }
  return { bytes, name, sha256: createHash("sha256").update(bytes).digest("hex"), source: "bundled" };
}

/** Only versioned Unix-socket libraries; legacy numbered libraries use another transport. */
export function selectBundledVideoLibrary(names: string[], deviceVersion: string): string | undefined {
  const candidates = names.filter(name => hypiumName.test(name));
  const selected = selectVideoLibrary(candidates.map(name => name.replace("libscrcpy_server-", "libscrcpy/libscrcpy_server_unix_").replace(/\.so$/, ".z.so")), deviceVersion);
  return selected?.replace("libscrcpy/libscrcpy_server_unix_", "libscrcpy_server-").replace(/\.z\.so$/, ".so");
}

async function readModernLibrary(asset: typeof videoBundle.assets[number]): Promise<BundledVideoLibrary> {
  const result = selection(await readBoundedRegularFile(join(modernDirectory(), asset.name), 4 * 1024 * 1024), asset.name);
  if (result.bytes.length !== asset.size || result.sha256 !== asset.sha256) throw new Error("The bundled video library failed integrity verification; repair Piora");
  return result;
}

/** All candidates belong to the shipped runtime; installed IDEs and external JARs are never inspected. */
export async function readBundledVideoLibrarySelection(deviceVersion: string): Promise<BundledVideoLibrary> {
  const modernName = selectVideoLibrary(videoBundle.assets.map(asset => `libscrcpy/${asset.name}`), deviceVersion)?.split("/").pop();
  const modern = videoBundle.assets.find(asset => asset.name === modernName);
  const hypium = selectBundledVideoLibrary(await readdir(hypiumDirectory()).catch(() => []), deviceVersion);
  if (modern && (!hypium || compareLibraryNames(modern.name, hypium) >= 0)) return readModernLibrary(modern);
  if (hypium) return selection(await readBoundedRegularFile(join(hypiumDirectory(), hypium), 4 * 1024 * 1024), hypium);
  throw new Error("The bundled runtime has no compatible video library; repair or update Piora");
}

export async function readBundledVideoLibrary(deviceVersion: string): Promise<Buffer> {
  return (await readBundledVideoLibrarySelection(deviceVersion)).bytes;
}

/** Version numbers select candidates; only the device loader proves ABI support. */
export async function readBundledVideoLibraryCandidates(deviceVersion: string): Promise<BundledVideoLibrary[]> {
  const preferred = await readBundledVideoLibrarySelection(deviceVersion);
  const candidates = [preferred];
  let remaining = videoBundle.assets.map(asset => `libscrcpy/${asset.name}`);
  for (let name = selectVideoLibrary(remaining, deviceVersion); name; name = selectVideoLibrary(remaining, deviceVersion)) {
    remaining = remaining.filter(candidate => candidate !== name);
    const asset = videoBundle.assets.find(asset => `libscrcpy/${asset.name}` === name)!;
    if (version(asset.name) !== version(preferred.name) || candidates.some(candidate => candidate.sha256 === asset.sha256)) continue;
    candidates.push(await readModernLibrary(asset));
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
    .filter(name => Number(device.split(".")[0]) < 7 || version(name)!.localeCompare("6.6", undefined, { numeric: true }) >= 0)
    .sort((a, b) => compareLibraryNames(b, a))[0];
}
