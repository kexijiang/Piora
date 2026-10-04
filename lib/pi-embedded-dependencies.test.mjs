import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findUnverifiedPiEmbeddedDependencies, verifyPiEmbeddedDependencies } from "../scripts/verify-pi-embedded-dependencies.mjs";

test("root package versions do not validate embedded Pi dependency code", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-embedded-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle");
  await mkdir(bundle, { recursive: true });
  await mkdir(join(root, "node_modules/undici"), { recursive: true });
  await writeFile(join(root, "node_modules/undici/package.json"), '{"name":"undici","version":"8.11.2"}');
  const chunk = join(bundle, "chunk.js");
  await writeFile(chunk, 'import { fetch } from "undici";');
  assert.deepEqual(await verifyPiEmbeddedDependencies(root), []);
  await writeFile(chunk, 'var fetch = __commonJS({"node_modules/undici/lib/web/fetch/index.js"(exports,module){module.exports={}}});');
  const findings = await findUnverifiedPiEmbeddedDependencies(root);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].modules, ["node_modules/undici/lib/web/fetch/index.js"]);
  await assert.rejects(verifyPiEmbeddedDependencies(root), /Unverified embedded Undici/);
  await rm(chunk);
  await symlink(join(root, "node_modules/undici/package.json"), chunk);
  await assert.rejects(verifyPiEmbeddedDependencies(root), /refuses a symlink/);
});
