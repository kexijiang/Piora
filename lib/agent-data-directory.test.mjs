import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("../desktop/src/agent-data-directory.ts");
  } catch {
    return import("../desktop/src/agent-data-directory.ts");
  }
}

const {
  createAgentDataDirectoryManifest,
  preflightAgentDataDirectoryChange,
  prepareAgentDataDirectoryChange,
} = await loadSubject();

test("switching without migration uses existing target data even when the old folder is missing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-agent-data-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "missing-old-agent");
  const target = path.join(root, "copied-agent");
  await mkdir(target);
  await writeFile(path.join(target, "settings.json"), '{"theme":"dark"}\n');
  const before = await createAgentDataDirectoryManifest(target);

  await preflightAgentDataDirectoryChange({ targetDirectory: target, migrate: false });
  await prepareAgentDataDirectoryChange({ currentDirectory: source, targetDirectory: target, migrate: false });

  assert.deepEqual(await createAgentDataDirectoryManifest(target), before);
});

test("verified migration preserves arbitrary extension data and keeps the source backup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-agent-data-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source-agent");
  const target = path.join(root, "target-agent");
  await mkdir(path.join(source, "extensions", "example", "data"), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "extensions", "example", "data", "state.sqlite"), "database-state");
  await writeFile(path.join(source, "extensions", "example", "data", "state.sqlite-wal"), "wal-state");
  await writeFile(path.join(source, "settings.json"), "{\"theme\":\"dark\"}\n");

  await prepareAgentDataDirectoryChange({
    currentDirectory: source,
    targetDirectory: target,
    migrate: true,
  });

  assert.deepEqual(
    await createAgentDataDirectoryManifest(target),
    await createAgentDataDirectoryManifest(source),
  );
  assert.equal(
    await readFile(path.join(source, "extensions", "example", "data", "state.sqlite"), "utf8"),
    "database-state",
  );
});

test("verified migration refuses to overwrite a non-empty target", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-agent-data-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source-agent");
  const target = path.join(root, "target-agent");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "source.json"), "source");
  await writeFile(path.join(target, "existing.json"), "existing");

  await assert.rejects(
    prepareAgentDataDirectoryChange({
      currentDirectory: source,
      targetDirectory: target,
      migrate: true,
    }),
    (error) => error?.code === "target-not-empty",
  );
  assert.equal(await readFile(path.join(target, "existing.json"), "utf8"), "existing");
});

test("preflight rejects a non-empty target before the runtime needs to stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-agent-data-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target-agent");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "existing.json"), "existing");

  await assert.rejects(
    preflightAgentDataDirectoryChange({ targetDirectory: target, migrate: true }),
    (error) => error?.code === "target-not-empty",
  );
  assert.equal(await readFile(path.join(target, "existing.json"), "utf8"), "existing");
});

test("preflight accepts a missing target directly below an existing filesystem root", { skip: process.platform !== "win32" }, async () => {
  const filesystemRoot = path.parse(tmpdir()).root;
  const target = path.join(filesystemRoot, `piora-agent-data-preflight-${process.pid}-${Date.now()}`);

  await preflightAgentDataDirectoryChange({ targetDirectory: target, migrate: true });
});
