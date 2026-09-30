import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  patchBundledBraceExpansion,
  patchBundledUndici,
  patchElectronBuilderWorkspaceCollector,
} from "../scripts/patch-bundled-dependencies.mjs";

async function writePackage(path, name, version, marker) {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(path, marker), `${version}\n`, "utf8");
}

async function withFixture(targetVersion, callback) {
  const root = await mkdtemp(join(tmpdir(), "piora-bundled-patch-"));
  try {
    await writePackage(join(root, "node_modules", "brace-expansion"), "brace-expansion", "5.0.12", "patched.js");
    await writePackage(
      join(
        root,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "node_modules",
        "brace-expansion",
      ),
      "brace-expansion",
      targetVersion,
      "bundled.js",
    );
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("replaces the known bundled vulnerable copy and is idempotent", async () => {
  await withFixture("5.0.7", async (root) => {
    const result = await patchBundledBraceExpansion(root);
    assert.deepEqual(result, { patched: true, from: "5.0.7", to: "5.0.12" });

    const target = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "brace-expansion",
    );
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(manifest.version, "5.0.12");
    assert.equal(await readFile(join(target, "patched.js"), "utf8"), "5.0.12\n");
    await assert.rejects(readFile(join(target, "bundled.js"), "utf8"), { code: "ENOENT" });

    assert.deepEqual(await patchBundledBraceExpansion(root), {
      patched: false,
      reason: "already-patched",
      version: "5.0.12",
    });
  });
});

test("fails closed for an unexpected bundled version", async () => {
  await withFixture("6.0.0", async (root) => {
    await assert.rejects(
      patchBundledBraceExpansion(root),
      /Refusing to replace unexpected bundled package brace-expansion@6\.0\.0/,
    );
  });
});

test("replaces Pi's bundled undici with the reviewed secure version", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-bundled-undici-patch-"));
  try {
    await writePackage(join(root, "node_modules", "undici"), "undici", "8.11.2", "secure.js");
    const target = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "undici",
    );
    await writePackage(target, "undici", "8.5.0", "bundled.js");

    assert.deepEqual(await patchBundledUndici(root), {
      patched: true,
      from: "8.5.0",
      to: "8.11.2",
    });
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(manifest.version, "8.11.2");
    assert.equal(await readFile(join(target, "secure.js"), "utf8"), "8.11.2\n");
    await assert.rejects(readFile(join(target, "bundled.js"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(await patchBundledUndici(root), {
      patched: false, reason: "already-patched", version: "8.11.2",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const { name, version, previous, patch } of [
  { name: "brace-expansion", version: "5.0.12", previous: "5.0.9", patch: patchBundledBraceExpansion },
  { name: "undici", version: "8.11.2", previous: "8.9.0", patch: patchBundledUndici },
]) {
  test(`${name} rejects an unreviewed replacement without changing the bundled copy`, async () => {
    const root = await mkdtemp(join(tmpdir(), "piora-patch-rejection-"));
    try {
      const source = join(root, "node_modules", name);
      const target = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", name);
      await writePackage(source, name, "99.0.0", "unreviewed.js");
      await writePackage(target, name, previous, "bundled.js");
      await assert.rejects(patch(root), /Expected locked/);
      assert.equal(JSON.parse(await readFile(join(target, "package.json"), "utf8")).version, previous);
      assert.equal(await readFile(join(target, "bundled.js"), "utf8"), `${previous}\n`);
      await assert.rejects(readFile(join(target, "unreviewed.js"), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${name} replaces the previous patch in a staged runtime using a separate source root`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "piora-staged-patch-"));
    try {
      const sourceRoot = join(fixture, "source");
      const stageRoot = join(fixture, "stage");
      const target = join(stageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", name);
      await writePackage(join(sourceRoot, "node_modules", name), name, version, "secure.js");
      await writePackage(target, name, previous, "bundled.js");
      assert.deepEqual(await patch(stageRoot, sourceRoot), { patched: true, from: previous, to: version });
      assert.equal(await readFile(join(target, "secure.js"), "utf8"), `${version}\n`);
      await assert.rejects(readFile(join(target, "bundled.js"), "utf8"), { code: "ENOENT" });
      assert.deepEqual(await patch(stageRoot, sourceRoot), { patched: false, reason: "already-patched", version });
      await writePackage(target, "unexpected-package", version, "bundled.js");
      await assert.rejects(patch(stageRoot, sourceRoot), /Refusing to replace unexpected bundled package/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("electron-builder traverses workspace dependencies before accepting npm's root tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-electron-builder-patch-"));
  try {
    const packageRoot = join(root, "node_modules", "app-builder-lib");
    await mkdir(join(packageRoot, "out", "util"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "app-builder-lib", version: "26.15.3" })}\n`,
      "utf8",
    );
    const collectorPath = join(packageRoot, "out", "util", "appFileCopier.js");
    await writeFile(
      collectorPath,
      "const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];\n",
      "utf8",
    );

    assert.deepEqual(await patchElectronBuilderWorkspaceCollector(root), {
      patched: true,
      version: "26.15.3",
    });
    assert.match(
      await readFile(collectorPath, "utf8"),
      /\[node_module_collector_1\.PM\.TRAVERSAL, await packager\.getPackageManager\(\)\]/,
    );
    assert.deepEqual(await patchElectronBuilderWorkspaceCollector(root), {
      patched: false,
      reason: "already-patched",
      version: "26.15.3",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
