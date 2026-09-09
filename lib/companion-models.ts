import fs from "node:fs";
import path from "node:path";
import { getRuntimeAgentDataDirectory, type RuntimeHomeEnvironment } from "./runtime-home";
import type { CompanionPet, CompanionPetDiagnostic } from "./companion-pets";

const SAFE_ID = /^(?!CON(?:\.|$)|PRN(?:\.|$)|AUX(?:\.|$)|NUL(?:\.|$)|COM[1-9](?:\.|$)|LPT[1-9](?:\.|$))[a-z0-9][a-z0-9_-]{0,63}$/i;
export const MODEL_MAX_BYTES = 64 * 1024 * 1024;
const ASSET_LIMITS = { "model.glb": MODEL_MAX_BYTES, "preview.png": 4 * 1024 * 1024, "pet.json": 8192 };
type AssetName = keyof typeof ASSET_LIMITS;

export interface CompanionModel3D {
  url: string;
  previewUrl: string;
  headBone?: string;
}

export class CompanionModelError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export function getCompanionModelsDirectory(environment: RuntimeHomeEnvironment = process.env): string {
  return path.join(getRuntimeAgentDataDirectory(environment), "piora", "pets-3d");
}

function assetPath(id: string, asset: AssetName, environment: RuntimeHomeEnvironment): string {
  if (!SAFE_ID.test(id)) throw new CompanionModelError("Invalid 3D pet id", 400);
  const root = getCompanionModelsDirectory(environment);
  const directory = path.join(root, id);
  const file = path.join(directory, asset);
  try {
    for (const item of [root, directory, file]) {
      if (fs.lstatSync(item).isSymbolicLink()) throw new CompanionModelError("Linked 3D pet paths are not supported");
    }
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CompanionModelError("Invalid 3D pet path");
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > ASSET_LIMITS[asset]) throw new CompanionModelError("Invalid 3D pet asset size");
    return file;
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    throw new CompanionModelError("3D pet asset not found", 404);
  }
}

function readAssetBytes(id: string, asset: AssetName, environment: RuntimeHomeEnvironment): Buffer {
  const file = assetPath(id, asset, environment);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > ASSET_LIMITS[asset]) throw new CompanionModelError("Invalid 3D pet asset size");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new CompanionModelError("Incomplete 3D pet asset");
      offset += count;
    }
    if (fs.fstatSync(descriptor).size !== stat.size) throw new CompanionModelError("3D pet changed while reading");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

/** Only self-contained GLB files are admitted; no external textures or buffers. */
export function validateCompanionGlb(bytes: Buffer): void {
  if (bytes.length < 28 || bytes.length > MODEL_MAX_BYTES || bytes.toString("ascii", 0, 4) !== "glTF"
    || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length
    || bytes.toString("ascii", 16, 20) !== "JSON") throw new CompanionModelError("Invalid GLB file");
  const length = bytes.readUInt32LE(12);
  if (length > 4 * 1024 * 1024 || 20 + length > bytes.length) throw new CompanionModelError("Invalid GLB JSON chunk");
  let document: unknown;
  try { document = JSON.parse(bytes.toString("utf8", 20, 20 + length)); }
  catch { throw new CompanionModelError("Invalid GLB JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new CompanionModelError("Invalid GLB document");
  const data = document as { asset?: { version?: unknown }; buffers?: unknown; images?: unknown };
  if (data.asset?.version !== "2.0") throw new CompanionModelError("GLB 2.0 is required");
  for (const entries of [data.buffers, data.images]) {
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== "object" || "uri" in entry)) {
      throw new CompanionModelError("3D pets must embed all textures and buffers");
    }
  }
}

export function readCompanionModelAsset(id: string, asset: "model.glb" | "preview.png", environment: RuntimeHomeEnvironment = process.env): Buffer {
  const bytes = readAssetBytes(id, asset, environment);
  if (asset === "model.glb") validateCompanionGlb(bytes);
  else if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new CompanionModelError("Invalid PNG preview");
  return bytes;
}

export function listCompanionModels(environment: RuntimeHomeEnvironment = process.env): { pets: CompanionPet[]; diagnostics: CompanionPetDiagnostic[] } {
  const root = getCompanionModelsDirectory(environment);
  const pets: CompanionPet[] = [];
  const diagnostics: CompanionPetDiagnostic[] = [];
  if (!fs.existsSync(root)) return { pets, diagnostics };
  if (fs.lstatSync(root).isSymbolicLink()) return { pets, diagnostics: [{ scope: "installed", message: "Linked 3D pet directory is not supported" }] };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const data = JSON.parse(readAssetBytes(entry.name, "pet.json", environment).toString("utf8"));
      if (data.schemaVersion !== 1 || data.renderer !== "glb" || data.id !== entry.name
        || typeof data.displayName !== "string" || !data.displayName.trim() || data.displayName.length > 100) throw new CompanionModelError("Invalid 3D pet manifest");
      assetPath(entry.name, "model.glb", environment);
      assetPath(entry.name, "preview.png", environment);
      const baseUrl = `/api/companion-pets/${encodeURIComponent(entry.name)}/model`;
      const frame = { width: 600, height: 700, columns: 1, rows: 1 };
      pets.push({
        id: entry.name, displayName: data.displayName,
        description: typeof data.description === "string" ? data.description.slice(0, 500) : undefined,
        author: typeof data.author === "string" ? data.author.slice(0, 150) : undefined,
        model3d: { url: baseUrl, previewUrl: `${baseUrl}?asset=preview`, headBone: typeof data.headBone === "string" ? data.headBone.slice(0, 100) : undefined },
        // Sprite metadata stays empty; the renderer dispatches on model3d.
        spriteVersionNumber: 1, spritesheetPath: "spritesheet.png", atlasUrl: null,
        width: 600, height: 700, frame, columns: 1, rows: 1, frameWidth: 600, frameHeight: 700, frameCount: 1, states: [],
        source: "piora", sourceKind: "piora-installed", sourceKey: `piora-model:${entry.name}`, installed: true,
      });
    } catch (error) {
      diagnostics.push({ scope: "installed", id: entry.name, message: error instanceof CompanionModelError ? error.message : "Invalid 3D pet manifest" });
    }
  }
  return { pets, diagnostics };
}
