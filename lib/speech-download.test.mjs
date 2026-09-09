import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const { downloadVerified } = await createJiti(import.meta.url).import("./speech-pack-manager.ts");
const bytes = Buffer.from("a complete and verified offline package");
const source = { name: "test.bin", url: "https://primary.test/file", fallbackUrls: ["https://backup.test/file"], algorithm: "sha256", encoding: "hex", digest: createHash("sha256").update(bytes).digest("hex") };

test("blocked primary falls back and resumes only at the exact byte offset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-speech-download-"));
  try {
    const destination = join(root, "test.bin");
    await writeFile(`${destination}.partial`, bytes.subarray(0, 9));
    const urls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      urls.push(url); assert.equal(options.headers.range, "bytes=9-");
      if (urls.length === 1) throw new Error("connection blocked");
      return new Response(bytes.subarray(9), { status: 206, headers: { "content-range": `bytes 9-${bytes.length - 1}/${bytes.length}` } });
    });
    await downloadVerified(source, destination);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(urls, [source.url, source.fallbackUrls[0]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("wrong ranges never corrupt a partial, and exhausted retries keep it for restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-speech-retain-"));
  try {
    const destination = join(root, "test.bin");
    await writeFile(`${destination}.partial`, bytes.subarray(0, 9));
    t.mock.method(globalThis, "fetch", async () => new Response(bytes.subarray(8), { status: 206, headers: { "content-range": `bytes 8-${bytes.length - 1}/${bytes.length}` } }));
    await assert.rejects(downloadVerified(source, destination), /错误的续传位置/);
    assert.deepEqual(await readFile(`${destination}.partial`), bytes.subarray(0, 9));
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
