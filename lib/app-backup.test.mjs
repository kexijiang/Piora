import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const backup = await jiti.import("./app-backup.ts");
const archive = await jiti.import("./app-backup-archive.ts");

test("encrypted application backup migrates credentials, sessions, custom Pocket, speech and client drafts and retains original data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-backup-test-"));
  const keys = ["PI_CODING_AGENT_DIR", "PIORA_HOME", "PIORA_DESKTOP_DATA_DIR", "PIORA_DESKTOP_USER_DATA_DIR", "PIORA_SPEECH_PACKS_DIR", "PIORA_ROOMS_ROOT", "PIORA_SESSION_CONTROL_ROOT", "PIORA_REMOTE_CONTROL_ROOT"];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
  try {
    for (const key of keys) delete process.env[key];
    const old = path.join(root, "old"), fresh = path.join(root, "new"), external = path.join(root, "external"), home = path.join(root, "home");
    process.env.PI_CODING_AGENT_DIR = old; process.env.PIORA_HOME = home;
    await save(path.join(old, "models.json"), { providers: { custom: { apiKey: "secret-test-key", models: [{ id: "m" }] } } });
    await save(path.join(old, "auth.json"), { custom: { type: "api_key", key: "credential-test" } });
    await save(path.join(old, "settings.json"), { defaultProvider: "custom", defaultModel: "m", skills: [] });
    const oldProject = path.join(root, "old-project"), newProject = path.join(root, "new-project"); await mkdir(newProject);
    await save(path.join(oldProject, ".pi/settings.json"), { enabledModels: ["custom/*"], defaultModel: "m" });
    const originalText = `用户原文\n${oldProject}\n` + "不可丢失".repeat(5000);
    await save(path.join(old, "sessions/encoded/one.jsonl"), [{ type: "session", id: "one", cwd: oldProject, parentSession: path.join(old, "sessions/encoded/parent.jsonl") }, { type: "message", message: { role: "user", content: originalText } }].map(JSON.stringify).join("\n"));
    await save(path.join(old, "piora/companion-storage.json"), { version: 1, directory: external });
    await save(path.join(external, "companion-runtime.json"), { settings: { todo: "重要" } });
    const library = path.join(external, "library");
    await save(path.join(old, "piora/pocket-storage.json"), { version: 1, library });
    await save(path.join(library, "transfer.json"), { version: 1, items: [{ id: "one", title: "笔记", content: originalText }] });
    await save(path.join(external, "unrelated-private.txt"), "must not export");
    const pack = path.join(external, "speech"); await save(path.join(pack, "model.onnx"), "模型数据".repeat(100000));
    await save(path.join(old, "piora/speech-settings.json"), { schema: 1, enabled: true, packDirectory: pack });
    await save(path.join(home, ".agents/skills/my-skill/SKILL.md"), "# Skill");
    const client = { version: 1, local: { "pi-theme": "dark" }, drafts: [["one", { value: originalText, files: [], images: [] }]], databases: [] };
    const { id, manifest } = await backup.exportApplicationBackup("password-123", client, [oldProject]);
    assert.ok(manifest.files >= 9); assert.ok(manifest.bytes > 1000000);
    const exported = path.join(backup.backupJob(id), "backup.piora");
    const raw = await readFile(exported); assert.equal(raw.includes(Buffer.from("secret-test-key")), false);
    await assert.rejects(archive.extractBackupArchive(exported, "wrong-password", path.join(root, "wrong")), /backup_auth/);
    assert.equal((await readdir(root)).includes("wrong"), false);
    const corrupt = path.join(root, "corrupt.piora"); const bad = Buffer.from(raw); bad[bad.length - 20] ^= 1; await writeFile(corrupt, bad);
    await assert.rejects(archive.extractBackupArchive(corrupt, "password-123", path.join(root, "corrupt-extracted")), /backup_auth/);
    process.env.PI_CODING_AGENT_DIR = fresh; process.env.PIORA_HOME = path.join(root, "new-home");
    await save(path.join(fresh, "models.json"), { original: "keep me" });
    const importId = await backup.newBackupJob(); await cp(exported, path.join(backup.backupJob(importId), "upload.piora"));
    await backup.previewApplicationBackup(importId, "password-123");
    const prepared = await backup.prepareApplicationRestore(importId, [{ from: oldProject, to: newProject }]);
    assert.deepEqual(JSON.parse(await readFile(path.join(fresh, "models.json"), "utf8")), { original: "keep me" });
    await backup.applyPendingApplicationRestore(); await backup.applyPendingApplicationRestore();
    assert.equal(JSON.parse(await readFile(path.join(fresh, "models.json"), "utf8")).providers.custom.apiKey, "secret-test-key");
    assert.deepEqual(JSON.parse(await readFile(path.join(prepared.previous, "models.json"), "utf8")), { original: "keep me" });
    const session = (await readFile(path.join(fresh, "sessions/encoded/one.jsonl"), "utf8")).split("\n").map(JSON.parse);
    assert.equal(session[0].cwd, newProject); assert.equal(session[0].parentSession, path.join(fresh, "sessions/encoded/parent.jsonl")); assert.equal(session[1].message.content, originalText);
    assert.deepEqual(JSON.parse(await readFile(path.join(newProject, ".pi/settings.json"), "utf8")), { enabledModels: ["custom/*"], defaultModel: "m" });
    const pointer = JSON.parse(await readFile(path.join(fresh, "piora/companion-storage.json"), "utf8")); assert.deepEqual(JSON.parse(await readFile(path.join(pointer.directory, "companion-runtime.json"), "utf8")), { settings: { todo: "重要" } });
    assert.equal((await readdir(pointer.directory)).includes("unrelated-private.txt"), false);
    assert.equal(JSON.parse(await readFile(path.join(fresh, "piora/import-client.json"), "utf8")).state.drafts[0][1].value, originalText);
    const speech = JSON.parse(await readFile(path.join(fresh, "piora/speech-settings.json"), "utf8")); assert.match(speech.packDirectory, /migrated[\\/]speech$/); assert.equal((await readFile(path.join(speech.packDirectory, "model.onnx"))).length, Buffer.byteLength("模型数据".repeat(100000)));
    // A migrated application must itself remain portable, including updated
    // project settings whose earlier snapshot is already inside the agent root.
    await save(path.join(newProject, ".pi/settings.json"), { defaultModel: "updated" });
    const second = await backup.exportApplicationBackup("password-123", client, [newProject]);
    const secondArchive = path.join(backup.backupJob(second.id), "backup.piora");
    process.env.PI_CODING_AGENT_DIR = path.join(root, "third");
    const secondImport = await backup.newBackupJob(); await cp(secondArchive, path.join(backup.backupJob(secondImport), "upload.piora"));
    await backup.previewApplicationBackup(secondImport, "password-123"); await backup.prepareApplicationRestore(secondImport, []); await backup.applyPendingApplicationRestore();
    assert.deepEqual(JSON.parse(await readFile(path.join(newProject, ".pi/settings.json"), "utf8")), { defaultModel: "updated" });
    assert.equal(JSON.parse(await readFile(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8")).providers.custom.apiKey, "secret-test-key");
  } finally { for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } await rm(root, { recursive: true, force: true }); }
});

test("archive paths reject traversal, Windows aliases, streams and absolute names", () => {
  for (const name of ["../outside", "/absolute", "agent/../escape", "agent\\escape", "agent/con.txt", "agent/file:stream", "agent/x. ", "agent//x"]) assert.throws(() => archive.safeBackupPath(path.resolve("test-root"), name), /backup_path/);
  assert.equal(backup.remapBackupPath("C:\\project-other\\file", [{ from: "C:\\project", to: "D:\\new" }]), "C:\\project-other\\file");
});

test("material attachment paths are rebound without rewriting the user's accompanying text", () => {
  const original = "用户原文 C:\\old\\uploads\\one.txt\n".repeat(1000);
  const material = { id: "one", name: "one.txt", path: "C:\\old\\uploads\\one.txt", byteLength: 3, sha256: "abc", lineCount: 1 };
  const prefix = "[[PIORA_PROMPT_MATERIALS_V1:", suffix = `The user's accompanying request is:\n${original}`;
  const content = `${prefix}${Buffer.from(JSON.stringify({ message: original, materials: [material] })).toString("base64url")}]]\n1. one.txt: ${material.path} (3 bytes)\n${suffix}`;
  const result = backup.remapBackupMetadata({ role: "user", content }, [{ from: "C:\\old", to: "D:\\new" }]);
  const payload = JSON.parse(Buffer.from(result.content.slice(prefix.length, result.content.indexOf("]]")), "base64url").toString("utf8"));
  assert.equal(payload.message, original); assert.equal(payload.materials[0].path, "D:\\new\\uploads\\one.txt");
  assert.ok(result.content.endsWith(suffix)); assert.ok(result.content.includes("1. one.txt: D:\\new\\uploads\\one.txt ("));
});

test("a failed external restore rolls the agent directory back without deleting either copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-backup-rollback-")); const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const target = path.join(root, "agent"); process.env.PI_CODING_AGENT_DIR = target; await mkdir(target); await writeFile(path.join(target, "old.txt"), "original");
    const id = await backup.newBackupJob(), staged = path.join(backup.backupJob(id), "ready-test"); await mkdir(staged); await writeFile(path.join(staged, "new.txt"), "incoming");
    const blockedParent = path.join(root, "not-a-directory"); await writeFile(blockedParent, "block");
    await writeFile(path.join(backup.backupControlRoot(), "pending.json"), JSON.stringify({ id, target, staged, previous: `${target}.before-import-${id}`, phase: "prepared", external: [{ target: path.join(blockedParent, "config.json"), content: "{}", previous: path.join(backup.backupJob(id), "external-before-0"), existed: false }] }));
    await assert.rejects(backup.applyPendingApplicationRestore()); assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "original");
    const jobFiles = await readdir(backup.backupJob(id)); assert.ok(jobFiles.includes("failed.json")); assert.ok(jobFiles.some((name) => name.startsWith("failed-")));
    await backup.applyPendingApplicationRestore(); assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "original");
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
