import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, mkdir, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);

test('worker reconnect rejects ambiguous writes without replay, preserves WAL data, bounds admission and releases threads', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piora-clipboard-recovery-')), runtime = path.join(root, 'runtime');
  await mkdir(runtime);
  let store, corrupt;
  try {
    for (const name of ['types', 'database', 'archive', 'store', 'worker']) {
      let source = await readFile(new URL(`../desktop/src/clipboard-${name}.ts`, import.meta.url), 'utf8');
      // Inject a real worker process exit AFTER SQL commit but BEFORE response.
      // Only this owned test build receives the fault; production has no crash command.
      if (name === 'worker') source = source.replace('case "capture": result = database.capture(request.value as ClipboardCapture); break;', 'case "capture": result = database.capture(request.value as ClipboardCapture); if ((request.value as ClipboardCapture).text === "test-commit-before-ack") process.exit(77); break;');
      await writeFile(path.join(runtime, `clipboard-${name}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
    }
    const { ClipboardStore } = require(path.join(runtime, 'clipboard-store.js'));
    store = new ClipboardStore(path.join(root, 'history')); await store.start();
    const original = await store.capture({ text: 'durable history', html: '<strong>durable history</strong>' });
    await store.mutate({ type: 'remark', id: original, value: 'keep this note' });
    await store.mutate({ type: 'star', ids: [original], value: true });
    await store.mutate({ type: 'shelf-add', ids: [original] });
    const before = await store.detail(original), firstWorker = store.worker;
    const interruptedExport = store.exportArchive(path.join(root, 'interrupted.piora-clipboard')).then(() => 'completed', () => 'interrupted');
    const requests = await Promise.allSettled([store.capture({ text: 'test-commit-before-ack' }), store.status(), store.query({ text: 'durable' })]);
    assert.ok(requests.every(result => result.status === 'rejected'), 'no pending operation receives a fabricated success after worker exit');
    assert.equal(store.pending.size, 0); assert.ok(store.failure);
    const retries = Array.from({ length: 20 }, () => store.reconnect());
    assert.ok(retries.every(promise => promise === retries[0]), 'simultaneous retries share one replacement worker');
    await Promise.all(retries);
    assert.equal(await interruptedExport, 'interrupted');
    assert.deepEqual(await readdir(path.join(root, 'history/snapshots')), [], 'known interrupted snapshots are cleaned only after export workers settle');
    assert.equal(firstWorker.threadId, -1, 'old worker has actually exited before reconnect completes');
    assert.deepEqual(await store.detail(original), before);
    const ambiguous = (await store.query({ text: 'test-commit-before-ack' })).items;
    assert.equal(ambiguous.length, 1); assert.equal(ambiguous[0].copies, 1, 'committed but unacknowledged capture was not replayed');
    assert.equal((await store.status()).total, 2);
    firstWorker.emit('message', { ready: false, error: 'late message from an obsolete worker' });
    assert.equal(store.failure, null, 'late old-generation messages cannot poison the healthy connection');
    const burst = await Promise.allSettled(Array.from({ length: 300 }, () => store.status()));
    assert.equal(burst.filter(result => result.status === 'fulfilled').length, 256);
    assert.ok(burst.filter(result => result.status === 'rejected').every(result => /请求过多/.test(result.reason.message)));
    assert.equal(store.pending.size, 0);
    const liveWorker = store.worker;
    await store.close(); await store.close();
    assert.equal(liveWorker.threadId, -1);
    await assert.rejects(store.capture({ text: 'never admitted after close' }), /正在关闭/);
    await assert.rejects(store.reconnect(), /正在关闭/);

    const corruptDirectory = path.join(root, 'corrupt'); await mkdir(corruptDirectory);
    const databaseFile = path.join(corruptDirectory, 'clipboard.sqlite'), bytes = Buffer.from('an unreadable database that must not be replaced');
    await writeFile(databaseFile, bytes);
    corrupt = new ClipboardStore(corruptDirectory);
    await assert.rejects(corrupt.start()); await assert.rejects(corrupt.reconnect());
    assert.deepEqual(await readFile(databaseFile), bytes, 'recovery does not recreate or overwrite a damaged database');
    await corrupt.worker.terminate();
    await rename(databaseFile, databaseFile + '.retained');
    await corrupt.reconnect();
    const recovered = await corrupt.capture({ text: 'storage available after externally repairing the path' });
    assert.equal((await corrupt.detail(recovered)).text, 'storage available after externally repairing the path');
    assert.deepEqual(await readFile(databaseFile + '.retained'), bytes);
  } finally {
    await Promise.allSettled([store?.close(), corrupt?.close()]);
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
