import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import JSZip from "jszip";
import { readBoundedRegularFile } from "./bounded-file";

const version = (name: string) => /(?:unix_|server-)(\d+\.\d+(?:\.\d+)?)-/.exec(name)?.[1];
export function selectVideoLibrary(names: string[], deviceVersion: string): string | undefined {
  const device = /\d+\.\d+(?:\.\d+)?/.exec(deviceVersion)?.[0];
  if (!device) return;
  return names.filter(name => /^libscrcpy\/libscrcpy_server_unix_\d+\.\d+(?:\.\d+)?-\d+\.z\.so$/.test(name))
    .filter(name => version(name)!.localeCompare(device, undefined, { numeric: true }) <= 0)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

/** Use the user's installed SDK. Never download or redistribute its native library. */
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
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 183) {
    throw new Error("SDK video library is not an ARM64 ELF file");
  }
  return bytes;
}
