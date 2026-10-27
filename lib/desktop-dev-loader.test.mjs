import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import desktopSource from "../scripts/desktop-dev-loader.cjs";

test("shared desktop sources run as ESM with real SQLite and clipboard archive imports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-dev-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  let cacheable = 0;
  for (const file of ["clipboard-types", "clipboard-database", "clipboard-archive"]) {
    const source = new URL(`../desktop/src/${file}.ts`, import.meta.url);
    const output = desktopSource.call({ resourcePath: source.pathname, cacheable() { cacheable++; } }, await readFile(source, "utf8"));
    await writeFile(join(root, `${file}.js`), output);
  }
  const { ClipboardDatabase } = await import(pathToFileURL(join(root, "clipboard-database.js")));
  const { exportClipboardArchive, importClipboardArchive } = await import(pathToFileURL(join(root, "clipboard-archive.js")));
  const original = new ClipboardDatabase(join(root, "original"));
  const restored = new ClipboardDatabase(join(root, "restored"));
  try {
    const id = original.capture({ text: "Shared server/desktop source round trip" });
    const archive = join(root, "archive.piora");
    await exportClipboardArchive(original, archive);
    await importClipboardArchive(restored, archive);
    assert.equal(restored.detail(id).text, "Shared server/desktop source round trip");
    assert.equal(cacheable, 3);
  } finally { original.close(); restored.close(); }
});
