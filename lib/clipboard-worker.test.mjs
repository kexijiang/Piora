import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
const require = createRequire(import.meta.url);

test("worker exports an independent snapshot while live capture and asset GC continue, then merges concurrently without duplicates", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-clipboard-worker-")), runtime = path.join(root, "runtime"); await mkdir(runtime);
  let source, destination;
  try {
    for (const name of ["types", "database", "archive", "store", "worker"]) {
      const text = await readFile(new URL(`../desktop/src/clipboard-${name}.ts`, import.meta.url), "utf8");
      await writeFile(path.join(runtime, `clipboard-${name}.js`), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
    }
    const { ClipboardStore } = require(path.join(runtime, "clipboard-store.js"));
    source = new ClipboardStore(path.join(root, "source")); destination = new ClipboardStore(path.join(root, "destination")); await Promise.all([source.start(), destination.start()]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const image = await source.capture({ image: png });
    const archive = path.join(root, "history.piora-clipboard"), exporting = source.exportArchive(archive);
    await source.mutate({ type: "delete", ids: [image] }); await source.mutate({ type: "purge", ids: [image] });
    const late = await source.capture({ text: "captured after snapshot" }); assert.equal((await source.detail(late)).text, "captured after snapshot");
    await exporting;
    const results = await Promise.all([destination.importArchive(archive), destination.importArchive(archive)]);
    assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 1); assert.equal((await destination.status()).total, 1);
    assert.equal((await destination.detail(image)).kind, "image"); await assert.rejects(destination.detail(late), /已被移除/);
    assert.equal((await source.status()).total, 1); assert.deepEqual(await readdir(path.join(root, "source/snapshots")), []);
    const original = await source.detail(late);
    const edited = await source.mutate({ type: "edit-copy", id: late, text: "edited in the worker" });
    assert.notEqual(edited.id, late); assert.equal((await source.detail(edited.id)).text, "edited in the worker");
    assert.deepEqual(await source.detail(late), original, "editing a new copy preserves the complete original record");
    const { ClipboardDatabase } = require(path.join(runtime, "clipboard-database.js"));
    const queryDirectory = path.join(root, "query"), seed = new ClipboardDatabase(queryDirectory);
    seed.importRecords((function* () {
      for (let i = 0; i < 4096; i++) yield { id: `worker-search-${i}`, title: `Record ${i}`, remark: "", text: `Worker content ${i}`, htmlHash: null, rtfHash: null, imageHash: null, files: [], source: { name: "Search", executable: "search.exe" }, createdAt: i, copiedAt: i, copies: 1, starred: false, deletedAt: null, shelfOrder: null };
    })(), () => { throw new Error("no assets"); }); seed.close();
    const queryStore = new ClipboardStore(queryDirectory); await queryStore.start();
    try {
      const cancelled = assert.rejects(queryStore.query({ text: "☄", requestId: 1 }, "renderer:1"), /查询已取消/);
      await queryStore.cancelQuery("renderer:1", 1); await cancelled;
      const replaced = assert.rejects(queryStore.query({ text: "☄", requestId: 2 }, "renderer:1"), /查询已取消/);
      const fresh = queryStore.query({ text: "Worker", requestId: 3 }, "renderer:1");
      assert.equal((await fresh).items.length, 100); await replaced;
      const unrelated = queryStore.query({ text: "☄", requestId: 4 }, "renderer:2");
      await queryStore.cancelQuery("renderer:1", 4); assert.deepEqual((await unrelated).items, []);
      const retained = queryStore.query({ text: "☄", requestId: 5 }, "renderer:1");
      await queryStore.cancelQuery("renderer:1", 2); assert.deepEqual((await retained).items, [], "late cancellation never cancels a later generation");
    } finally { await queryStore.close(); }
  } finally {
    await Promise.allSettled([source?.close(), destination?.close()]); assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true });
  }
});
