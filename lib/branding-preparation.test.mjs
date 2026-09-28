import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { loadBranding, runtimeBranding } from "../scripts/branding-config.mjs";
import { prepareBranding } from "../scripts/prepare-branding.mjs";
import { verifyBrandStartupAssets } from "../scripts/verify-brand-startup-assets.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "piora-brand-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["branding", "desktop/build/piora-icon.svg", "desktop/build/startup", "desktop/build/portable-splash.bmp", "desktop/electron-builder.yml", "desktop/package.json"]) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await cp(resolve(sourceRoot, file), resolve(root, file), { recursive: true });
  }
  await mkdir(resolve(root, "app"));
  return root;
}
async function config(root, patch) {
  const file = resolve(root, "branding/piora/branding.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...original, ...patch }));
}
async function hashes(root) {
  const result = {};
  for (const file of ["app/favicon.ico", "public/icons/icon-192.png", "public/icons/icon-512.png", "public/offline.html", ".branding/resources/icon.ico", ".branding/resources/tray.ico", ".branding/resources/tray.png", "lib/generated/brand.ts", "desktop/src/generated/brand.ts", ".branding/runtime.json"]) {
    result[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  }
  return result;
}

const customSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1267ab"/></svg>';

async function customAssets(root) {
  await writeFile(resolve(root, "branding/piora/icon.svg"), customSvg);
  await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ef7812" } }).png().toFile(resolve(root, "branding/piora/tray.png"));
  await config(root, { icon: "icon.svg", trayIcon: "tray.png" });
}

test("Piora custom icons reach Web, desktop and startup, and defaults can be restored", async t => {
  const root = await fixture(t);
  await prepareBranding(root, "piora");
  const before = await hashes(root);
  await customAssets(root);
  const custom = await prepareBranding(root, "piora");
  assert.equal(custom.displayName, "Piora");
  assert.deepEqual(custom.updateChannels, { stable: "latest", preview: "beta" });
  const changed = await hashes(root);
  for (const file of ["app/favicon.ico", "public/icons/icon-192.png", "public/icons/icon-512.png", ".branding/resources/icon.ico", ".branding/resources/tray.ico"]) {
    assert.notEqual(changed[file], before[file], file);
  }
  assert.deepEqual(await readFile(resolve(root, ".branding/resources/startup/icon.png")), await readFile(resolve(root, ".branding/resources/icon.png")));
  assert.match(await readFile(resolve(root, "public/offline.html"), "utf8"), /Piora/);
  await cp(resolve(sourceRoot, "branding/piora/branding.json"), resolve(root, "branding/piora/branding.json"));
  await prepareBranding(root, "piora");
  assert.deepEqual(await hashes(root), before);
});

test("packaged startup rejects mismatched identity, missing and corrupt resources", async t => {
  const root = await fixture(t);
  await customAssets(root);
  const runtime = await prepareBranding(root, "piora");
  const packaged = resolve(root, "packaged-resources");
  await cp(resolve(root, ".branding/resources"), packaged, { recursive: true });
  await cp(resolve(root, ".branding/runtime.json"), resolve(packaged, "brand.json"));
  await verifyBrandStartupAssets(root, packaged, "piora");
  await writeFile(resolve(packaged, "brand.json"), JSON.stringify({ ...runtime, id: "other" }));
  await assert.rejects(verifyBrandStartupAssets(root, packaged, "piora"), /brand configuration mismatch/);
  await cp(resolve(root, ".branding/runtime.json"), resolve(packaged, "brand.json"));
  const icon = resolve(packaged, "startup/icon.png");
  await writeFile(icon, "wrong icon");
  await assert.rejects(verifyBrandStartupAssets(root, packaged, "piora"), /differs from brand source/);
  await rm(icon);
  await assert.rejects(verifyBrandStartupAssets(root, packaged, "piora"), /missing or unexpected/);
});

test("custom artwork preserves Piora installation identity and release channels", async t => {
  const root = await fixture(t);
  await customAssets(root);
  const runtime = await prepareBranding(root, "piora");
  for (const preview of [false, true]) {
    const built = JSON.parse(await readFile(resolve(root, `.branding/builder${preview ? "-preview" : ""}.json`), "utf8"));
    assert.equal(built.appId, "io.github.kexijiang.piora");
    assert.equal(built.executableName, "Piora");
    assert.equal(built.linux.executableName, "Piora");
    assert.equal(built.productName, "Piora");
    assert.equal(built.publish.channel, preview ? "beta" : "latest");
    assert.equal(built.publish.owner, "kexijiang");
    assert.equal(built.publish.repo, "Piora");
    assert.equal(built.nsis.artifactName, "Piora-${version}-win-x64-setup.${ext}");
    assert.equal(built.nsis.deleteAppDataOnUninstall, false);
    assert.equal(built.win.icon, "../.branding/resources/icon.ico");
    assert.equal(built.linux.icon, "../.branding/resources/icon.png");
    assert.ok(!built.extraResources.some(entry => /app-update/.test(entry.to)));
  }
  assert.deepEqual(runtime, runtimeBranding(await loadBranding(root, "piora")));
});

test("custom tray PNG drives every Windows ICO size and can revert to the main icon", async t => {
  const root = await fixture(t);
  await customAssets(root);
  await prepareBranding(root, "piora");
  const source = resolve(root, "branding/piora/tray.png");
  assert.deepEqual(await readFile(source), await readFile(resolve(root, ".branding/resources/tray.png")));
  const ico = await readFile(resolve(root, ".branding/resources/tray.ico"));
  assert.notDeepEqual(ico, await readFile(resolve(root, ".branding/resources/icon.ico")));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), sizes.length);
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const actual = await sharp(ico.subarray(offset, offset + length)).raw().toBuffer();
    const expected = await sharp(source).resize(size, size, { fit: "contain" }).raw().toBuffer();
    assert.deepEqual(actual, expected);
  }
  await config(root, { trayIcon: undefined });
  await prepareBranding(root, "piora");
  assert.deepEqual(await readFile(resolve(root, ".branding/resources/tray.ico")), await readFile(resolve(root, ".branding/resources/icon.ico")));
});

test("invalid or retired branding is rejected before replacing generated outputs", async t => {
  const root = await fixture(t);
  await prepareBranding(root, "piora");
  const before = await hashes(root);
  for (const id of ["unknown", "xiaoyi-harness"]) {
    await assert.rejects(prepareBranding(root, id), /Unknown PIORA_BRAND/);
    assert.deepEqual(await hashes(root), before);
  }
  for (const patch of [
    { artifactPrefix: "Other" },
    { updateChannels: { stable: "other", preview: "beta" } },
    { displayName: "../invalid" }, { displayName: " bad name " }, { repository: "elsewhere" },
  ]) {
    await cp(resolve(sourceRoot, "branding/piora/branding.json"), resolve(root, "branding/piora/branding.json"));
    await config(root, patch);
    await assert.rejects(prepareBranding(root, "piora"));
    assert.deepEqual(await hashes(root), before);
  }
});

test("custom icons cannot escape their directory or contain scripts and external resources", async t => {
  const root = await fixture(t);
  await config(root, { icon: "../../desktop/build/piora-icon.svg" });
  await assert.rejects(loadBranding(root, "piora"), /escapes the brand directory/);
  await config(root, { icon: "icon.svg" });
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/icon.png"/></svg>',
  ]) {
    await writeFile(resolve(root, "branding/piora/icon.svg"), svg);
    await assert.rejects(loadBranding(root, "piora"), /self-contained/);
  }
});
