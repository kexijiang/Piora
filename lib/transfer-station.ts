import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanionLibraryItem } from "./companion-store";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getPocketStorageInfo } from "./pocket-storage";
import type { RuntimeHomeEnvironment } from "./runtime-home";

interface StoredItem extends CompanionLibraryItem { fileName?: string }
export const MAX_TRANSFER_ITEMS = 200;
export const MAX_TRANSFER_IMAGE_BYTES = 8 * 1024 * 1024;
export function readTransferItems(environment: RuntimeHomeEnvironment = process.env): StoredItem[] {
  const { dataFile } = getPocketStorageInfo("library", environment);
  if (!existsSync(dataFile)) return [];
  const data = JSON.parse(readFileSync(dataFile, "utf8")) as { version: number; items: StoredItem[] };
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("中转站数据格式无效，请检查存储文件。");
  return data.items;
}
function writeItems(items: StoredItem[], environment: RuntimeHomeEnvironment) {
  const storage = getPocketStorageInfo("library", environment);
  mkdirSync(storage.directory, { recursive: true });
  writePrivateFileAtomicSync(storage.dataFile, JSON.stringify({ version: 1, items }, null, 2));
}
export function transferItemsForClient(environment: RuntimeHomeEnvironment = process.env): CompanionLibraryItem[] {
  return readTransferItems(environment).map(({ fileName, ...item }) => ({ ...item, content: fileName ? `/api/companion/library/image?id=${encodeURIComponent(item.id)}&v=${item.updatedAt}` : item.content }));
}
export function addTransferItem(input: { content: string; title?: string; kind?: string; language?: string }, environment: RuntimeHomeEnvironment = process.env) {
  const items = readTransferItems(environment);
  if (items.length >= MAX_TRANSFER_ITEMS) throw new Error("中转站已存满 200 条，请先移除不需要的内容。");
  const now = Date.now();
  const uuid = randomUUID();
  const item: StoredItem = { id: `library:${uuid}`, kind: input.kind === "code" || input.kind === "command" ? input.kind : "note", content: input.content, title: (input.title?.trim() || input.content.trim().split(/\r?\n/)[0] || "暂存内容").slice(0, 120), pinned: false, createdAt: now, updatedAt: now, ...(input.language ? { language: input.language.slice(0, 40) } : {}) };
  const image = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(input.content);
  let imagePath: string | undefined;
  if (input.kind === "image") {
    if (!image) throw new Error("只支持 PNG、JPEG、WebP 和 GIF 图片。");
    const bytes = Buffer.from(image[2], "base64");
    if (!bytes.length || bytes.length > MAX_TRANSFER_IMAGE_BYTES) throw new Error("单张图片不能超过 8 MB。");
    const storage = getPocketStorageInfo("library", environment);
    mkdirSync(storage.directory, { recursive: true });
    item.kind = "image"; item.content = ""; item.fileName = `item-${uuid}.${image[1]}`;
    item.title = input.title?.trim().slice(0, 120) || "暂存图片";
    imagePath = join(storage.directory, item.fileName);
    writeFileSync(imagePath, bytes, { flag: "wx", mode: 0o600 });
  } else if (!input.content.trim() || input.content.length > 200_000) throw new Error("文字不能为空，且不能超过 200,000 字符。");
  try { writeItems([item, ...items], environment); }
  catch (error) { if (imagePath) unlinkSync(imagePath); throw error; }
  return item;
}
export function updateTransferItem(id: string, patch: { pinned?: boolean; title?: string; remove?: boolean }, environment: RuntimeHomeEnvironment = process.env) {
  const items = readTransferItems(environment);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error("内容已不存在，请刷新后重试。");
  const next = patch.remove ? items.filter((entry) => entry.id !== id) : items.map((entry) => entry.id === id ? { ...entry, ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}), ...(patch.title?.trim() ? { title: patch.title.trim().slice(0, 120) } : {}), updatedAt: Date.now() } : entry);
  writeItems(next, environment);
  if (patch.remove && item.fileName && /^item-[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(item.fileName)) {
    try { unlinkSync(join(getPocketStorageInfo("library", environment).directory, item.fileName)); } catch { /* An orphan is safer than losing the manifest update. */ }
  }
}
export function readTransferImage(id: string, environment: RuntimeHomeEnvironment = process.env) {
  const item = readTransferItems(environment).find((entry) => entry.id === id);
  if (!item?.fileName || !/^item-[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(item.fileName)) return null;
  return { bytes: readFileSync(join(getPocketStorageInfo("library", environment).directory, item.fileName)), type: `image/${item.fileName.split(".").pop()}` };
}
export function migrateTransferItems(legacy: CompanionLibraryItem[], environment: RuntimeHomeEnvironment = process.env) {
  if (existsSync(getPocketStorageInfo("library", environment).dataFile)) return false;
  const storage = getPocketStorageInfo("library", environment);
  mkdirSync(storage.directory, { recursive: true });
  const created: string[] = [];
  try {
    const items: StoredItem[] = legacy.map((item) => {
      if (item.kind !== "image") return { ...item };
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(item.content);
      if (!match) throw new Error("旧收藏包含无效图片，原数据已保留，迁移未完成。");
      const fileName = `item-${randomUUID()}.${match[1]}`;
      const path = join(storage.directory, fileName);
      writeFileSync(path, Buffer.from(match[2], "base64"), { flag: "wx", mode: 0o600 });
      created.push(path);
      return { ...item, fileName, content: "" };
    });
    // Publish exactly once after every image has been written. A failed migration
    // remains retryable; legacy data stays intact as a recovery copy.
    writeItems(items, environment);
  } catch (error) {
    for (const path of created) { try { unlinkSync(path); } catch { /* Orphans are safe. */ } }
    throw error;
  }
  return true;
}
