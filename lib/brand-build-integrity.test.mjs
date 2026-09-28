import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { brandBuildFingerprint, recordBrandBuild, verifyBrandBuilds } from "../scripts/brand-build-integrity.mjs";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "piora-brand-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [".branding/runtime.json", ".branding/builder.json", ".branding/builder-preview.json",
    "lib/generated/brand.ts", "desktop/src/generated/brand.ts", "app/favicon.ico", "public/offline.html",
    "public/icons/icon-192.png", "public/icons/icon-512.png", "public/icons/apple-touch-icon.png",
    ".branding/resources/startup/icon.png", "desktop/dist/generated/brand.js", ".next/BUILD_ID", ".next/standalone/.next/BUILD_ID"];
  for (const file of files) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await writeFile(resolve(root, file), "fixture");
  }
  return root;
}

test("packaging requires both targets compiled against the current brand resources", async t => {
  const root = await fixture(t);
  const fingerprint = await brandBuildFingerprint(root);
  await assert.rejects(verifyBrandBuilds(root), { code: "ENOENT" });
  await recordBrandBuild(root, "web", fingerprint);
  await assert.rejects(verifyBrandBuilds(root), { code: "ENOENT" });
  await recordBrandBuild(root, "desktop", fingerprint);
  await verifyBrandBuilds(root);
  await writeFile(resolve(root, ".branding/runtime.json"), "other brand");
  await recordBrandBuild(root, "desktop", await brandBuildFingerprint(root));
  await assert.rejects(verifyBrandBuilds(root), /web was compiled with different brand/);
});

test("brand asset changes during compilation and stale staged Web output fail closed", async t => {
  const root = await fixture(t);
  const before = await brandBuildFingerprint(root);
  await writeFile(resolve(root, ".branding/resources/startup/icon.png"), "new artwork");
  await assert.rejects(recordBrandBuild(root, "desktop", before), /changed during compilation/);
  const after = await brandBuildFingerprint(root);
  await writeFile(resolve(root, ".next/standalone/.next/BUILD_ID"), "old build");
  await assert.rejects(recordBrandBuild(root, "web", after), /Staged Web build/);
});

test("replaced compiled output cannot reuse an earlier brand stamp", async t => {
  const root = await fixture(t);
  const fingerprint = await brandBuildFingerprint(root);
  await recordBrandBuild(root, "web", fingerprint);
  await recordBrandBuild(root, "desktop", fingerprint);
  await writeFile(resolve(root, "desktop/dist/generated/brand.js"), "wrong compiled brand");
  await assert.rejects(verifyBrandBuilds(root), /desktop output changed/);
});
