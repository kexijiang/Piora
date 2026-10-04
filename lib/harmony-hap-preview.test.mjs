import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { previewHapArtifact } = await jiti.import("./harmony/runtime/hap-preview.ts");
const { importHapArtifact } = await jiti.import("./harmony/runtime/hap-artifact.ts");
const archive = async (configuration, filename = "module.json") => {
  const zip = new JSZip(); zip.file(filename, typeof configuration === "string" ? configuration : JSON.stringify(configuration));
  zip.file("ets/modules.abc", Buffer.from("fixture-code"));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};
const configuration = { app: { bundleName: "com.test.fixture", versionName: "2.0", versionCode: 42, debug: true, fingerprint: "do-not-expose" },
  module: { name: "entry", type: "entry", deviceTypes: ["phone", "tablet"], abilities: [{ name: "EntryAbility" }], requestPermissions: [{ name: "ohos.permission.CAMERA" }] } };

test("HAP preview reads declared package metadata without claiming signature verification or changing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-hap-preview-"));
  try {
    const path = join(directory, "app.hap"), bytes = await archive(configuration); await writeFile(path, bytes);
    const preview = await previewHapArtifact(path);
    assert.deepEqual(preview, { filename: "app.hap", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bundleName: "com.test.fixture",
      versionName: "2.0", versionCode: 42, moduleName: "entry", moduleType: "entry", abilities: ["EntryAbility"], deviceTypes: ["phone", "tablet"], permissions: ["ohos.permission.CAMERA"], signature: "unverified" });
    assert.deepEqual(await readFile(path), bytes);
    const legacy = { app: { bundleName: "com.test.legacy", version: { name: "1.0", code: 7 } }, module: { name: "entry", reqPermissions: [{ name: "ohos.permission.MICROPHONE" }] } };
    await writeFile(path, await archive(legacy, "config.json"));
    const oldPreview = await previewHapArtifact(path); assert.equal(oldPreview.versionCode, 7); assert.equal(oldPreview.versionName, "1.0");
    assert.deepEqual(oldPreview.permissions, ["ohos.permission.MICROPHONE"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HAP preview rejects malformed, redirected and oversized configuration and respects cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-hap-preview-invalid-"));
  try {
    const path = join(directory, "app.hap");
    for (const bytes of [Buffer.from("not-a-zip"), await archive("not-json"), await archive({ app: { bundleName: "bad;command" }, module: {} }), await archive(configuration, "../module.json"), await archive(" ".repeat(600 * 1024))]) {
      await writeFile(path, bytes); await assert.rejects(() => previewHapArtifact(path), error => error.code === "INVALID_ARGUMENT" && error.details?.reason === "hap-preview-invalid");
    }
    const signal = AbortSignal.abort(); await assert.rejects(() => previewHapArtifact(path, signal), error => error.name === "AbortError");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HAP import binds the frozen bytes to the preview hash before creating an install artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-hap-preview-bind-"));
  try {
    const path = join(directory, "app.hap"), store = join(directory, "store"), bytes = await archive(configuration); await writeFile(path, bytes);
    const preview = await previewHapArtifact(path);
    await writeFile(path, await archive({ ...configuration, app: { ...configuration.app, versionCode: 43 } }));
    await assert.rejects(() => importHapArtifact(path, store, preview.sha256), error => error.code === "STALE_SNAPSHOT" && error.details?.dispatchState === "not-sent");
    assert.equal(existsSync(store), false, "a stale preview is rejected before any artifact is published");
    await writeFile(path, bytes);
    const frozen = await importHapArtifact(path, store, preview.sha256);
    assert.deepEqual(await readFile(frozen), bytes);
    await writeFile(path, Buffer.from("changed-after-freeze")); assert.deepEqual(await readFile(frozen), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("package preview API requires desktop authentication and an allowed workspace file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-hap-preview-route-"));
  const originalToken = process.env.PI_DESKTOP_TOKEN, originalRoots = globalThis.__piAllowedRootsCache;
  const token = randomBytes(32).toString("base64url");
  process.env.PI_DESKTOP_TOKEN = token;
  try {
    const allowed = join(directory, "allowed"); await mkdir(allowed);
    const path = join(allowed, "app.hap"), outside = join(directory, "outside.hap");
    await writeFile(path, await archive(configuration)); await writeFile(outside, await archive(configuration));
    globalThis.__piAllowedRootsCache = { roots: new Set([allowed.replace(/\\/g, "/")]), expiresAt: Date.now() + 60_000 };
    const route = await createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } }).import("../app/api/harmony/packages/route.ts");
    const request = (body, headers = {}) => new Request("http://localhost:30141/api/harmony/packages", { method: "POST", headers: {
      host: "localhost:30141", origin: "http://localhost:30141", "content-type": "application/json", "x-pi-desktop-token": token, ...headers,
    }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal((await route.POST(request({ action: "preview", hapPath: path }, { "x-pi-desktop-token": "" }))).status, 403);
    assert.equal((await route.POST(request({ action: "preview", hapPath: path }, { origin: "https://attacker.example" }))).status, 403);
    assert.equal((await route.POST(request({ action: "preview", hapPath: outside }))).status, 400);
    assert.equal((await route.POST(request("{"))).status, 400);
    assert.equal((await route.POST(request(" ".repeat(9000)))).status, 413);
    assert.equal((await route.POST(request({ action: "preview", hapPath: path }, { "content-type": "text/plain" }))).status, 415);
    const response = await route.POST(request({ action: "preview", hapPath: path }));
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
    const result = await response.json(); assert.equal(result.preview.bundleName, "com.test.fixture"); assert.equal(result.preview.signature, "unverified");
    assert.equal("path" in result.preview, false);
  } finally {
    if (originalToken === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = originalToken;
    globalThis.__piAllowedRootsCache = originalRoots;
    await rm(directory, { recursive: true, force: true });
  }
});
