import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, stat, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { getRuntimeAgentDataDirectory, getRuntimeHomeDirectory } from "./runtime-home";
import { getCompanionStorageInfo } from "./companion-storage";
import { getPocketStorageInfo } from "./pocket-storage";
import { readSpeechSettings, speechSettingsPath } from "./speech-settings";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { validateClientBackup } from "./app-backup-client";
import { PROMPT_MATERIAL_MARKER_PREFIX, PROMPT_MATERIAL_MARKER_SUFFIX, type PromptMaterialMarkerPayload } from "./prompt-material-format";
import { backupInventory, createBackupArchive, extractBackupArchive, safeBackupPath, type BackupManifest, type BackupRoot } from "./app-backup-archive";

export const backupControlRoot = () => `${getRuntimeAgentDataDirectory()}.piora-transfer`;
export function backupJob(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("backup_job"); return path.join(backupControlRoot(), id); }
export async function newBackupJob() { const id = randomUUID(); await mkdir(backupJob(id), { recursive: true, mode: 0o700 }); return id; }
function relativeInside(root: string, file: string) { const result = path.relative(root, file); return result === "" || (!result.startsWith("..") && !path.isAbsolute(result)); }

export async function exportApplicationBackup(password: string, client: unknown, projects: string[]) {
  validateClientBackup(client);
  projects = [...new Set(projects)];
  const id = await newBackupJob(), agent = getRuntimeAgentDataDirectory();
  const roots: BackupRoot[] = [{ id: "agent", source: agent, destination: "." }];
  const warnings = ["Project source files are excluded. Reassociate project directories after import.", "Browser sign-in, OS credentials and system integrations may require sign-in or authorization on the new computer."];
  const add = (root: BackupRoot) => { if (!relativeInside(agent, root.source) && existsSync(root.source)) roots.push(root); };
  const companion = getCompanionStorageInfo(); add({ id: "companion", source: companion.directory, destination: "piora/migrated/companion", files: existsSync(companion.dataFile) ? [path.basename(companion.dataFile)] : [] });
  for (const scope of ["library", "json"] as const) {
    const info = getPocketStorageInfo(scope); const files = existsSync(info.dataFile) ? [path.basename(info.dataFile)] : [];
    if (scope === "library" && files.length) {
      const content = JSON.parse(await readFile(info.dataFile, "utf8"));
      for (const item of content.items ?? []) if (item.fileName) { if (!/^item-[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(item.fileName)) throw new Error("backup_path"); files.push(item.fileName); }
    }
    add({ id: scope, source: info.directory, destination: `piora/migrated/${scope}`, files: [...new Set(files)] });
  }
  const speech = await readSpeechSettings(); add({ id: "speech", source: speech.packDirectory, destination: "piora/migrated/speech" });
  add({ id: "skills", source: path.join(getRuntimeHomeDirectory(), ".agents", "skills"), destination: "piora/migrated/skills" });
  for (const [env, id, destination] of [["PIORA_ROOMS_ROOT", "rooms", "piora/rooms"], ["PIORA_SESSION_CONTROL_ROOT", "session-control", "piora/session-control"], ["PIORA_REMOTE_CONTROL_ROOT", "remote-control", "piora/remote-control"]]) {
    const source = process.env[env]; if (source) add({ id, source: path.resolve(source), destination });
  }
  const desktopData = process.env.PIORA_DESKTOP_DATA_DIR;
  if (desktopData) add({ id: "desktop-runtime", source: desktopData, destination: "piora/migrated/desktop-runtime", files: ["speech-settings.json", "harmony.json"].filter((file) => existsSync(path.join(desktopData, file))) });
  const desktopHome = process.env.PIORA_DESKTOP_USER_DATA_DIR;
  if (desktopHome) add({ id: "desktop", source: desktopHome, destination: "piora/migrated/desktop", files: ["desktop-state.json", "browser-login-hosts.json"].filter((file) => existsSync(path.join(desktopHome, file))) });
  projects.forEach((project, index) => {
    const source = path.join(project, ".pi");
    if (existsSync(path.join(source, "settings.json"))) roots.push({ id: `project-${index}`, source, destination: `piora/migrated/projects/${index}`, files: ["settings.json"] });
  });
  const clientRoot = path.join(backupJob(id), "client"); await mkdir(clientRoot);
  await writeFile(path.join(clientRoot, "state.json"), JSON.stringify(client), { mode: 0o600 });
  roots.push({ id: "client", source: clientRoot, destination: "piora/migrated/client" });
  const entries = await backupInventory(roots, warnings);
  const manifest: BackupManifest = { product: "piora", version: 1, platform: process.platform, exportedAt: new Date().toISOString(), roots, projects: [...new Set(projects)], warnings, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
  await createBackupArchive(path.join(backupJob(id), "backup.piora"), password, manifest, entries);
  return { id, manifest };
}
export async function previewApplicationBackup(id: string, password: string) {
  // A fresh extraction directory lets a mistyped password be retried without re-uploading.
  const attempt = randomUUID(); const output = path.join(backupJob(id), attempt);
  const manifest = await extractBackupArchive(path.join(backupJob(id), "upload.piora"), password, output);
  writePrivateFileAtomicSync(path.join(backupJob(id), "preview.json"), JSON.stringify({ attempt, manifest }));
  return manifest;
}
export function readBackupPreview(id: string): { attempt: string; manifest: BackupManifest } { return JSON.parse(readFileSync(path.join(backupJob(id), "preview.json"), "utf8")); }

const destinations: Record<string, string> = { agent: ".", companion: "piora/migrated/companion", library: "piora/migrated/library", json: "piora/migrated/json", speech: "piora/migrated/speech", skills: "piora/migrated/skills", rooms: "piora/rooms", "session-control": "piora/session-control", "remote-control": "piora/remote-control", "desktop-runtime": "piora/migrated/desktop-runtime", desktop: "piora/migrated/desktop", client: "piora/migrated/client" };
export interface BackupPathMapping { from: string; to: string }
export function remapBackupPath(value: string, mappings: BackupPathMapping[]): string {
  const normalized = value.replace(/\\/g, "/");
  for (const { from, to } of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    const prefix = from.replace(/\\/g, "/").replace(/\/$/, "");
    const insensitive = /^[a-z]:\//i.test(prefix);
    const v = insensitive ? normalized.toLowerCase() : normalized, p = insensitive ? prefix.toLowerCase() : prefix;
    if (v === p) return to;
    if (v.startsWith(p + "/")) {
      const destinationPath = path.win32.isAbsolute(to) && !path.posix.isAbsolute(to) ? path.win32 : path.posix;
      return destinationPath.join(to, ...normalized.slice(prefix.length + 1).split("/"));
    }
  }
  return value;
}
/** Only path-bearing metadata is changed. User prose, code and model output stay byte-for-byte intact. */
export function remapBackupMetadata(value: unknown, mappings: BackupPathMapping[], key = ""): unknown {
  if (typeof value === "string") {
    if ((key === "content" || key === "text") && value.startsWith(PROMPT_MATERIAL_MARKER_PREFIX)) {
      const end = value.indexOf(PROMPT_MATERIAL_MARKER_SUFFIX, PROMPT_MATERIAL_MARKER_PREFIX.length);
      if (end > 0) try {
        const payload = JSON.parse(Buffer.from(value.slice(PROMPT_MATERIAL_MARKER_PREFIX.length, end), "base64url").toString("utf8")) as PromptMaterialMarkerPayload;
        if (typeof payload.message === "string" && Array.isArray(payload.materials)) {
          const materials = payload.materials.map((material) => ({ ...material, path: remapBackupPath(material.path, mappings) }));
          const marker = `${PROMPT_MATERIAL_MARKER_PREFIX}${Buffer.from(JSON.stringify({ ...payload, materials })).toString("base64url")}${PROMPT_MATERIAL_MARKER_SUFFIX}`;
          // Only change the generated inventory before the untouched accompanying request.
          const suffix = payload.message.trim() ? `The user's accompanying request is:\n${payload.message}` : "The attached material itself is the user's request. Read it in full and respond to it.";
          if (value.endsWith(suffix)) {
            let inventory = value.slice(end + PROMPT_MATERIAL_MARKER_SUFFIX.length, value.length - suffix.length);
            payload.materials.forEach((material, index) => { inventory = inventory.replace(`${index + 1}. ${material.name}: ${material.path} (`, `${index + 1}. ${material.name}: ${materials[index].path} (`); });
            return marker + inventory + suffix;
          }
        }
      } catch { /* Preserve unfamiliar marker versions. */ }
    }
    if (["cwd", "projectRoot", "parentSession", "sessionFile", "sessionPath", "directory", "packDirectory", "path", "worktreePath", "filePath", "root"].includes(key)) return remapBackupPath(value, mappings);
    if (["skills", "extensions", "prompts", "themes", "packages"].includes(key)) return remapBackupPath(value, mappings);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => remapBackupMetadata(entry, mappings, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [remapBackupPath(name, mappings), remapBackupMetadata(entry, mappings, name)]));
  return value;
}
async function mapJsonFiles(directory: string, mappings: BackupPathMapping[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") await mapJsonFiles(file, mappings); continue; }
    if (!/\.jsonl?$/.test(entry.name)) continue;
    const size = (await stat(file)).size;
    if (size > 256 * 1024 ** 2) throw new Error("backup_metadata_limit");
    const original = await readFile(file, "utf8");
    let next: string;
    try { next = entry.name.endsWith(".jsonl") ? original.split("\n").map((row) => row.trim() ? JSON.stringify(remapBackupMetadata(JSON.parse(row), mappings)) : row).join("\n") : JSON.stringify(remapBackupMetadata(JSON.parse(original), mappings)); }
    catch { continue; /* Opaque third-party JSON is preserved; do not erase it. */ }
    if (next !== original) await writeFile(file, next, { mode: 0o600 });
  }
}
export async function prepareApplicationRestore(id: string, requestedMappings: BackupPathMapping[]) {
  const { attempt, manifest } = readBackupPreview(id);
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw new Error("backup_job");
  const extracted = path.join(backupJob(id), attempt), staged = path.join(backupJob(id), `ready-${randomUUID()}`), target = getRuntimeAgentDataDirectory();
  const mappings: BackupPathMapping[] = [];
  for (const mapping of requestedMappings) {
    if (!manifest.projects.includes(mapping.from) || typeof mapping.to !== "string" || !path.isAbsolute(mapping.to) || !(await stat(mapping.to)).isDirectory()) throw new Error("backup_mapping");
    mappings.push(mapping);
  }
  if (!manifest.roots.some((root) => root.id === "agent")) throw new Error("backup_format");
  await mkdir(staged, { recursive: true });
  const seen = new Set<string>();
  for (const root of [...manifest.roots].sort((a, b) => Number(b.id === "agent") - Number(a.id === "agent"))) {
    const projectMatch = /^project-(\d+)$/.exec(root.id);
    if ((!Object.hasOwn(destinations, root.id) && !(projectMatch && Number(projectMatch[1]) < manifest.projects.length)) || seen.has(root.id)) throw new Error("backup_format"); seen.add(root.id);
    const destination = projectMatch ? `piora/migrated/projects/${projectMatch[1]}` : destinations[root.id]; const src = safeBackupPath(extracted, root.id);
    // Re-exported applications already contain migrated snapshots. Refresh those
    // snapshots with the current external configuration inside this staging copy.
    if (root.id !== "client" && existsSync(src)) await cp(src, destination === "." ? staged : safeBackupPath(staged, destination), { recursive: true, force: destination !== ".", errorOnExist: destination === "." });
    if (root.id !== "client" && !projectMatch) mappings.push({ from: root.source, to: destination === "." ? target : safeBackupPath(target, destination) });
  }
  await mapJsonFiles(staged, mappings);
  const patch = async (file: string, update: (value: Record<string, unknown>) => unknown) => { let data = {}; try { data = JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(update(data)), { mode: 0o600 }); };
  if (seen.has("companion")) await patch(path.join(staged, "piora/companion-storage.json"), (data) => ({ ...data, version: 1, directory: path.join(target, destinations.companion) }));
  await patch(path.join(staged, "piora/pocket-storage.json"), (data) => ({ ...data, version: 1, ...Object.fromEntries(["library", "json"].flatMap((id) => seen.has(id) ? [[id, path.join(target, destinations[id])]] : typeof data[id] === "string" ? [[id, remapBackupPath(data[id], mappings)]] : [])) }));
  if (seen.has("skills")) await patch(path.join(staged, "settings.json"), (data) => ({ ...data, skills: [...new Set([...(Array.isArray(data.skills) ? data.skills : []), path.join(target, destinations.skills)])] }));
  const speechFile = path.join(staged, seen.has("desktop-runtime") ? "piora/migrated/desktop-runtime/speech-settings.json" : "piora/speech-settings.json");
  if (seen.has("speech")) await patch(speechFile, (data) => ({ ...data, schema: 1, packDirectory: path.join(target, destinations.speech) }));
  const clientFile = path.join(extracted, "client/state.json");
  if (!existsSync(clientFile)) throw new Error("backup_format");
  const client = JSON.parse(await readFile(clientFile, "utf8")); validateClientBackup(client);
  await writeFile(path.join(staged, "piora/import-client.json"), JSON.stringify({ id, state: client, mappings }), { mode: 0o600 });
  const external: Array<{ source: string; target: string }> = [];
  manifest.projects.forEach((project, index) => {
    const selected = requestedMappings.find((mapping) => mapping.from === project)?.to ?? project;
    const source = path.join(staged, `piora/migrated/projects/${index}/settings.json`);
    if (existsSync(source) && path.isAbsolute(selected) && existsSync(selected)) external.push({ source, target: path.join(selected, ".pi/settings.json") });
  });
  if (existsSync(speechFile)) external.push({ source: speechFile, target: speechSettingsPath() });
  if (process.env.PIORA_DESKTOP_DATA_DIR && existsSync(path.join(staged, "piora/migrated/desktop-runtime/harmony.json"))) external.push({ source: path.join(staged, "piora/migrated/desktop-runtime/harmony.json"), target: path.join(process.env.PIORA_DESKTOP_DATA_DIR, "harmony.json") });
  if (process.env.PIORA_DESKTOP_USER_DATA_DIR && existsSync(path.join(staged, "piora/migrated/desktop/browser-login-hosts.json"))) external.push({ source: path.join(staged, "piora/migrated/desktop/browser-login-hosts.json"), target: path.join(process.env.PIORA_DESKTOP_USER_DATA_DIR, "browser-login-hosts.json") });
  const desktopState = path.join(staged, "piora/migrated/desktop/desktop-state.json");
  if (process.env.PIORA_DESKTOP_USER_DATA_DIR && existsSync(desktopState)) {
    const destination = path.join(process.env.PIORA_DESKTOP_USER_DATA_DIR, "desktop-state.json");
    const incoming = JSON.parse(await readFile(desktopState, "utf8")); let current: Record<string, unknown> = {};
    try { current = JSON.parse(await readFile(destination, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const key of ["piAgentDirectory", "serverPort", "lastLaunchedVersion"]) { delete incoming[key]; if (key in current) incoming[key] = current[key]; }
    await writeFile(desktopState, JSON.stringify({ ...current, ...incoming }), { mode: 0o600 });
    external.push({ source: desktopState, target: destination });
  }
  // The journal is outside every directory being swapped. Original data is retained as a recovery copy.
  const transaction = { id, staged, target, previous: `${target}.before-import-${id}`, phase: "prepared", external: external.filter((file) => !relativeInside(target, file.target)).map((file, index) => ({ target: file.target, content: readFileSync(file.source, "utf8"), previous: path.join(backupJob(id), `external-before-${index}`), existed: existsSync(file.target) })) };
  const journal = path.join(backupControlRoot(), "pending.json");
  if (existsSync(journal)) throw new Error("backup_pending");
  await writeFile(journal, JSON.stringify(transaction), { flag: "wx", mode: 0o600 });
  return { id, previous: transaction.previous };
}

/** Must run before SDK/store modules and automation workers are imported. */
export async function applyPendingApplicationRestore() {
  const journal = path.join(backupControlRoot(), "pending.json"); if (!existsSync(journal)) return;
  const tx = JSON.parse(await readFile(journal, "utf8"));
  if (tx.target !== getRuntimeAgentDataDirectory() || tx.previous !== `${tx.target}.before-import-${tx.id}` || path.dirname(tx.staged) !== backupJob(tx.id)) throw new Error("backup_journal");
  const save = () => writePrivateFileAtomicSync(journal, JSON.stringify(tx));
  try {
    if (tx.phase === "prepared") {
      for (const file of tx.external) if (file.existed && !existsSync(file.previous)) await cp(file.target, file.previous, { errorOnExist: true });
      tx.phase = "swapping"; save();
    }
    if (tx.phase === "swapping") {
      if (existsSync(tx.staged)) {
        if (!existsSync(tx.previous) && existsSync(tx.target)) await rename(tx.target, tx.previous);
        await rename(tx.staged, tx.target);
      } else if (!existsSync(tx.target)) throw new Error("backup_journal");
      tx.phase = "external"; save();
    }
    for (const file of tx.external) { mkdirSync(path.dirname(file.target), { recursive: true }); writePrivateFileAtomicSync(file.target, file.content); }
    tx.phase = "complete"; save();
    await rename(journal, path.join(backupJob(tx.id), "completed.json"));
  } catch (error) {
    // Keep all copies. A failed restore returns to the pre-import data on the next startup.
    if (existsSync(tx.previous)) {
      if (existsSync(tx.target)) await rename(tx.target, path.join(backupJob(tx.id), `failed-${randomUUID()}`));
      await rename(tx.previous, tx.target);
    }
    for (const file of tx.external) { if (file.existed && existsSync(file.previous)) await cp(file.previous, file.target); else if (!file.existed) await unlink(file.target).catch(() => {}); }
    await rename(journal, path.join(backupJob(tx.id), "failed.json"));
    throw error;
  }
}
