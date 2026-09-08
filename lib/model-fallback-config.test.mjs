import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
const { readModelFallbackConfig, writeModelFallbackConfig } = await createJiti(import.meta.url).import("./model-fallback-config.ts");

test("switch defaults off, persists both directions, and rejects non-boolean input", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readModelFallbackConfig(root), { enabled: false });
  writeModelFallbackConfig({ enabled: true }, root);
  assert.deepEqual(readModelFallbackConfig(root), { enabled: true });
  for (const value of [null, {}, { enabled: "false" }, { enabled: 1 }]) assert.throws(() => writeModelFallbackConfig(value, root), /boolean/);
  assert.deepEqual(readModelFallbackConfig(root), { enabled: true });
  writeModelFallbackConfig({ enabled: false }, root);
  assert.deepEqual(readModelFallbackConfig(root), { enabled: false });
  writeFileSync(join(root, "piora", "model-fallback.json"), "broken");
  assert.deepEqual(readModelFallbackConfig(root), { enabled: false });
});
