import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { previewPrivilegeConfig, applyPrivilegeConfig, restorePrivilegeConfig } = await jiti.import("./harmony/privilege-config.ts");
const fingerprint = "A".repeat(64);

test("system-image privilege edit previews, backs up, verifies and restores an allowed configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-privilege-test-"));
  allowFileRoot(directory);
  const path = join(directory, "install_list_capability.json");
  const original = JSON.stringify({ install_list: [{ bundleName: "com.example.other", keepAlive: true }] }, null, 2);
  await writeFile(path, original);
  try {
    const edit = { path, bundleName: "com.example.demo", fingerprint, singleton: true, allowAppUsePrivilegeExtension: true };
    const preview = await previewPrivilegeConfig(edit);
    assert.equal(preview.before, original);
    assert.equal(preview.changes.length, 2);
    assert.equal(JSON.parse(preview.after).install_list[0].keepAlive, true);
    const applied = await applyPrivilegeConfig(edit, preview.sourceHash);
    assert.equal(await readFile(applied.backupPath, "utf8"), original);
    assert.equal(JSON.parse(await readFile(path, "utf8")).install_list[1].app_signature[0], fingerprint);
    await assert.rejects(applyPrivilegeConfig(edit, preview.sourceHash), error => error.code === "STALE_SNAPSHOT");
    const restored = await restorePrivilegeConfig(path, applied.backupPath, applied.appliedHash);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(JSON.parse(await readFile(restored.backupPath, "utf8")).install_list[1].singleton, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("system-image privilege preview rejects a mismatched certificate and unrelated filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-privilege-test-"));
  allowFileRoot(directory);
  const path = join(directory, "install_list_capability.json");
  await writeFile(path, JSON.stringify({ install_list: [{ bundleName: "com.example.demo", app_signature: ["B".repeat(64)] }] }));
  try {
    await assert.rejects(previewPrivilegeConfig({ path, bundleName: "com.example.demo", fingerprint, singleton: true, allowAppUsePrivilegeExtension: false }), /different certificate/);
    await assert.rejects(previewPrivilegeConfig({ path: join(directory, "other.json"), bundleName: "com.example.demo", fingerprint, singleton: true, allowAppUsePrivilegeExtension: false }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
