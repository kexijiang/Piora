import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const backup = await jiti.import("./app-backup.ts");
const { ClipboardDatabase } = await jiti.import("../desktop/src/clipboard-database.ts");
const { exportClipboardArchive } = await jiti.import("../desktop/src/clipboard-archive.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("full encrypted backup restores clipboard atomically with the application and rolls both back on failure", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-clipboard-app-backup-"));
  const keys = ["PI_CODING_AGENT_DIR", "PIORA_HOME", "PIORA_DESKTOP_DATA_DIR", "PIORA_DESKTOP_USER_DATA_DIR", "PIORA_ROOMS_ROOT", "PIORA_SESSION_CONTROL_ROOT", "PIORA_REMOTE_CONTROL_ROOT"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]])), oldSend = process.send; let source;
  const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  try {
    for (const key of keys) delete process.env[key];
    const oldAgent = path.join(root, "old-agent"), newAgent = path.join(root, "new-agent"), oldDesktop = path.join(root, "old-desktop"), newDesktop = path.join(root, "new-desktop");
    const oldProject = path.join(root, "old-project"), newProject = path.join(root, "new-project"); await mkdir(newProject);
    process.env.PI_CODING_AGENT_DIR = oldAgent; process.env.PIORA_HOME = path.join(root, "home"); process.env.PIORA_DESKTOP_USER_DATA_DIR = oldDesktop;
    await save(path.join(oldAgent, "settings.json"), { defaultModel: "archive-model" }); await save(path.join(oldProject, ".pi/settings.json"), {});
    source = new ClipboardDatabase(path.join(oldDesktop, "clipboard"));
    const content = `Keep literal prose ${oldProject}`;
    const id = source.capture({ text: content, html: "<b>Original formatting</b>", image: png, files: [{ path: path.join(oldProject, "image.png"), name: "image.png", directory: false }] });
    source.mutate({ type: "shelf-add", ids: [id] }); source.mutate({ type: "remark", id, value: "important note" }); source.mutate({ type: "settings", value: { enabled: true } });
    process.send = message => {
      assert.equal(message.type, "pi-desktop:clipboard-backup-request");
      const snapshotPath = path.join(root, `snapshot-${message.requestId}`); source.createSnapshot(snapshotPath);
      const snapshot = new ClipboardDatabase(snapshotPath, Date.now, { maintenance: false });
      void exportClipboardArchive(snapshot, path.join(oldDesktop, "clipboard/backup-exports", `${message.requestId}.piora-clipboard`)).then(() => process.emit("message", { type: "pi-desktop:clipboard-backup-response", requestId: message.requestId, snapshotId: message.requestId, ok: true })).catch(error => process.emit("message", { type: "pi-desktop:clipboard-backup-response", requestId: message.requestId, ok: false, error: String(error) })).finally(() => snapshot.close());
      return true;
    };
    const client = { version: 1, local: {}, drafts: [], databases: [] };
    const exported = await backup.exportApplicationBackup("secret-password", client, [oldProject]);
    assert.ok(exported.manifest.roots.some(root => root.id === "clipboard"));
    assert.deepEqual(await readdir(path.join(oldDesktop, "clipboard/backup-exports")), []);
    const file = path.join(backup.backupJob(exported.id), "backup.piora");
    process.env.PI_CODING_AGENT_DIR = newAgent; process.env.PIORA_DESKTOP_USER_DATA_DIR = newDesktop;
    await save(path.join(newAgent, "settings.json"), { defaultModel: "previous-model" });
    const previous = new ClipboardDatabase(path.join(newDesktop, "clipboard")); const previousId = previous.capture({ text: "previous clipboard" }); previous.close();
    const prepare = async () => {
      const importId = await backup.newBackupJob(); await cp(file, path.join(backup.backupJob(importId), "upload.piora"));
      await backup.previewApplicationBackup(importId, "secret-password");
      await backup.prepareApplicationRestore(importId, [{ from: oldProject, to: newProject }]); return importId;
    };
    const importId = await prepare();
    const unchanged = new ClipboardDatabase(path.join(newDesktop, "clipboard")); assert.equal(unchanged.detail(previousId).text, "previous clipboard"); unchanged.close();
    await backup.applyPendingApplicationRestore(); await backup.applyPendingApplicationRestore();
    const restored = new ClipboardDatabase(path.join(newDesktop, "clipboard"));
    assert.equal(restored.detail(id).text, content); assert.equal(restored.detail(id).files[0].path, path.join(newProject, "image.png"));
    assert.equal(restored.detail(id).remark, "important note"); assert.equal(restored.detail(id).shelfOrder, 0); assert.equal(restored.settings().enabled, true);
    const later = restored.capture({ text: "work after successful restore" }); restored.close();
    const retained = new ClipboardDatabase(path.join(newDesktop, `clipboard.before-import-${importId}`)); assert.equal(retained.detail(previousId).text, "previous clipboard"); retained.close();
    await save(path.join(newAgent, "settings.json"), { defaultModel: "before-failed-restore" });
    const failedId = await prepare();
    const journal = JSON.parse(await readFile(path.join(backup.backupControlRoot(), "pending.json"), "utf8"));
    await save(path.join(journal.directories[0].source, "restore.json"), { id: "corrupt-marker" });
    await assert.rejects(backup.applyPendingApplicationRestore(), /backup_journal/);
    assert.equal(JSON.parse(await readFile(path.join(newAgent, "settings.json"), "utf8")).defaultModel, "before-failed-restore");
    const rolledBack = new ClipboardDatabase(path.join(newDesktop, "clipboard")); assert.equal(rolledBack.detail(later).text, "work after successful restore"); rolledBack.close();
    assert.ok((await readdir(backup.backupJob(failedId))).some(name => name.startsWith("clipboard-failed-")));
    process.env.PIORA_DESKTOP_USER_DATA_DIR = path.join(newAgent, "nested-desktop");
    await assert.rejects(prepare(), /backup_clipboard_overlap/);
    assert.equal(JSON.parse(await readFile(path.join(newAgent, "settings.json"), "utf8")).defaultModel, "before-failed-restore");
    assert.ok(!(await readdir(backup.backupControlRoot())).includes("pending.json"), "overlapping roots are rejected before a restore journal is admitted");
  } finally {
    source?.close(); process.send = oldSend; for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true });
  }
});
