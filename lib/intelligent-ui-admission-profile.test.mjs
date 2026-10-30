import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { patchPiSourceProfile, verifyPiSourceProfile } from "../scripts/pi-source-profile.mjs";
import { patchIntelligentUiAdmission, verifyIntelligentUiAdmission } from "../scripts/patch-intelligent-ui-admission.mjs";

const certificate = JSON.parse(await readFile(new URL("../scripts/pi-tool-admission-1.4.0.json", import.meta.url), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("real npm SDK copy preserves source-profile integrity before and after admission installation", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-admission-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  await Promise.all(["@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "undici"].map(name =>
    cp(resolve("node_modules", name), join(modules, name), { recursive: true })));
  const sdk = join(modules, "@earendil-works/pi-coding-agent");
  assert.equal((await verifyPiSourceProfile(root)).sourceFiles, 1013);
  const initialState = await verifyIntelligentUiAdmission(root, { allowOriginal: true });
  assert.ok(["original", "patched"].includes(initialState.state));
  assert.equal((await patchPiSourceProfile(root)).reason, "already-patched");

  // The installer must reject unknown bytes before touching any other file.
  const paths = certificate.files.map(entry => join(modules, entry.path));
  const initial = await Promise.all(paths.map(path => readFile(path)));
  await writeFile(paths[2], Buffer.concat([initial[2], Buffer.from("\n// unknown bytes outside the patch\n")]));
  await assert.rejects(patchIntelligentUiAdmission(root), /commitment/);
  assert.deepEqual(await readFile(paths[0]), initial[0]);
  assert.deepEqual(await readFile(paths[1]), initial[1]);
  await writeFile(paths[2], initial[2]);

  await patchIntelligentUiAdmission(root);
  assert.deepEqual(await verifyIntelligentUiAdmission(root), { version: 2, state: "patched" });
  assert.equal((await verifyPiSourceProfile(root)).sourceFiles, 1013);
  assert.equal((await patchPiSourceProfile(root)).reason, "already-patched");
  assert.deepEqual(await patchIntelligentUiAdmission(root), { version: 2, updated: 0 });

  // Reconstruct the ONE reviewed session-file insertion to simulate a crashed
  // three-file installation, then prove the preimage against its certificate.
  const sessionPatched = await readFile(paths[2], "utf8");
  const sessionOriginal = sessionPatched
    .replace("                    /* piora-tool-admission-v1 */\n                    admitToolCall: admission,\n", "")
    .replace("runToolCall: (toolCall, parentId, signal, onUpdate, admission) => {", "runToolCall: (toolCall, parentId, signal, onUpdate) => {")
    .replace("executeTool: Object.assign((callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options), { getAdmission: () => this.agent.admitToolCall }),", "executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),");
  assert.equal(sha256(sessionOriginal), certificate.files[2].beforeSha256);
  await writeFile(paths[2], sessionOriginal);
  await assert.rejects(verifyIntelligentUiAdmission(root, { allowOriginal: true }), /incomplete/);
  await assert.rejects(verifyPiSourceProfile(root), /incomplete/);
  await assert.rejects(patchPiSourceProfile(root), /incomplete/);
  assert.deepEqual(await patchIntelligentUiAdmission(root), { version: 2, updated: 1 });
  assert.equal((await verifyPiSourceProfile(root)).sourceFiles, 1013);

  // Every target byte and every other distribution path remains covered.
  for (const path of paths) {
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from("\n// unreviewed\n")]));
    await assert.rejects(verifyPiSourceProfile(root), /commitment/);
    await assert.rejects(patchIntelligentUiAdmission(root), /commitment/);
    await writeFile(path, bytes);
  }
  const other = join(sdk, "dist/core/http-dispatcher.js");
  const original = await readFile(other);
  await writeFile(other, Buffer.concat([original, Buffer.from("\n// unreviewed\n")]));
  await assert.rejects(verifyPiSourceProfile(root), /differs from the verified official/);
  await writeFile(other, original);
  const extra = join(sdk, "dist/unreviewed.js");
  await writeFile(extra, "export const injected = true;");
  await assert.rejects(verifyPiSourceProfile(root), /differs from the verified official/);
  await rm(extra);

  const coreDist = join(modules, "@earendil-works/pi-agent-core/dist");
  const movedDist = join(modules, "@earendil-works/pi-agent-core/dist-real");
  await rename(coreDist, movedDist);
  await symlink(movedDist, coreDist, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyPiSourceProfile(root), /unsafe entry/);
  await assert.rejects(patchIntelligentUiAdmission(root), /unsafe entry/);
  await rm(coreDist);
  await rename(movedDist, coreDist);
  assert.equal((await verifyPiSourceProfile(root)).sourceFiles, 1013);
});
