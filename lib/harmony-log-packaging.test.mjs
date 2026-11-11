import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";
import { HARMONY_LOG_RUNTIME_FILES, verifyPackagedHarmonyLogAssets } from "../scripts/verify-packaged-harmony-logs.mjs";

test("log workers, archive dependencies and Windows RAR runtime are unpacked together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-log-packaging-"));
  const source = join(directory, "source"), archive = join(directory, "runtime.asar");
  try {
    for (const file of HARMONY_LOG_RUNTIME_FILES) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      const text = file.endsWith("package.json") ? JSON.stringify({ version: file.includes("yauzl") ? "3.4.0" : "26.4.0" }) : "fixture " + file;
      await writeFile(join(source, file), text);
    }
    await createWebRuntimeArchive(source, archive);
    const result = await verifyPackagedHarmonyLogAssets(source, archive + ".unpacked");
    assert.equal(result.realSidecar, true);
    assert.match(await readFile(join(archive + ".unpacked", "lib/harmony/log-library/vendor/log-worker.mjs"), "utf8"), /fixture/);
    await rm(join(archive + ".unpacked", "node_modules/7z-bin/bin/win/x64/7z.dll"));
    await assert.rejects(verifyPackagedHarmonyLogAssets(source, archive + ".unpacked"), /7z\.dll/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
