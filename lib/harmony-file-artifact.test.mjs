import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const { importDeviceFileArtifact } = await createJiti(import.meta.url).import("./harmony/runtime/file-artifact.ts");

test("large uploads freeze through bounded chunks and reuse an identical verified artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-file-artifact-test-"));
  try {
    const source = join(directory, "source.bin"), store = join(directory, "store");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    await writeFile(source, bytes);
    const artifact = await importDeviceFileArtifact(source, store);
    assert.equal(artifact, join(store, `${createHash("sha256").update(bytes).digest("hex")}.bin`));
    assert.deepEqual(await readFile(artifact), bytes);
    assert.equal(await importDeviceFileArtifact(source, store), artifact);
    assert.deepEqual(await readdir(store), [artifact.split(/[\\/]/).at(-1)]);
    await writeFile(artifact, Buffer.alloc(bytes.length, 0x33));
    await assert.rejects(importDeviceFileArtifact(source, store), /integrity verification/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancelled upload preparation leaves no frozen artifact or temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-file-artifact-cancel-"));
  try {
    const source = join(directory, "source.bin"), store = join(directory, "store");
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(importDeviceFileArtifact(source, store, controller.signal), error => error.code === "COMMAND_ABORTED");
    assert.deepEqual(await readdir(store), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
