import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getRuntimeAgentDataDirectory, type RuntimeHomeEnvironment } from "./runtime-home";

export type PocketStorageScope = "library" | "json";
export function isPocketStorageScope(value: unknown): value is PocketStorageScope { return value === "library" || value === "json"; }
export function getPocketStorageInfo(scope: PocketStorageScope, environment: RuntimeHomeEnvironment = process.env) {
  const root = join(getRuntimeAgentDataDirectory(environment), "piora");
  const configFile = join(root, "pocket-storage.json");
  const defaultDirectory = join(root, scope === "library" ? "transfer-station" : "json-workbench");
  let directory = defaultDirectory;
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    if (typeof config[scope] === "string") directory = validateDirectory(config[scope]);
  }
  return { directory, defaultDirectory, dataFile: join(directory, scope === "library" ? "transfer.json" : "json-workbench.json"), configFile, customized: directory !== defaultDirectory };
}
function validateDirectory(value: string) {
  if (!value.trim() || !isAbsolute(value.trim())) throw new Error("请输入完整的绝对路径，例如 D:\\Piora\\中转站");
  const directory = resolve(value.trim());
  if (directory === parse(directory).root) throw new Error("请选择一个文件夹，不能直接使用磁盘根目录。");
  return directory;
}
export function updatePocketStorageDirectory(scope: PocketStorageScope, requested: string, environment: RuntimeHomeEnvironment = process.env) {
  const current = getPocketStorageInfo(scope, environment);
  const directory = validateDirectory(requested);
  if (directory === current.directory) return current;
  // Only our manifest and referenced images belong to this migration, never unrelated files.
  const files = existsSync(current.dataFile) ? [basename(current.dataFile)] : [];
  if (scope === "library" && files.length) {
    const manifest = JSON.parse(readFileSync(current.dataFile, "utf8")) as { items: Array<{ fileName?: string }> };
    for (const item of manifest.items) {
      if (!item.fileName) continue;
      if (!/^item-[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(item.fileName)) throw new Error("中转站图片索引无效，未切换目录。");
      files.push(item.fileName);
    }
  }
  for (const file of files) if (existsSync(join(directory, file))) throw new Error(`目标文件夹已有 ${file}，请使用空文件夹以免覆盖。`);
  if (existsSync(join(directory, basename(current.dataFile)))) throw new Error("目标文件夹已有数据，请换一个文件夹。");
  mkdirSync(directory, { recursive: true });
  const copied: string[] = [];
  try {
    for (const file of files) {
      const destination = join(directory, file);
      copyFileSync(join(current.directory, file), destination, constants.COPYFILE_EXCL);
      copied.push(destination);
      if (!readFileSync(join(current.directory, file)).equals(readFileSync(destination))) throw new Error("复制校验失败，原目录继续使用。");
    }
    const config = existsSync(current.configFile) ? JSON.parse(readFileSync(current.configFile, "utf8")) : {};
    mkdirSync(parse(current.configFile).dir, { recursive: true });
    writePrivateFileAtomicSync(current.configFile, JSON.stringify({ ...config, version: 1, [scope]: directory }, null, 2));
  } catch (error) {
    for (const file of copied) { try { unlinkSync(file); } catch { /* Original data and pointer remain available. */ } }
    throw error;
  }
  // Retain source files as a recovery copy; a failed copy never switches the pointer.
  return getPocketStorageInfo(scope, environment);
}
