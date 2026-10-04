import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVerifiedAuditLock } from "../scripts/audit-runtime-dependencies.mjs";

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "piora-audit-test-"));
  const lock = { lockfileVersion: 3, packages: { "": { name: "fixture" } } };
  try {
    for (const [name, before, after] of [["brace-expansion", "5.0.9", "5.0.12"], ["undici", "8.10.2", "8.11.2"]]) {
      const source = `node_modules/${name}`;
      const target = `node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`;
      lock.packages[source] = { version: after, resolved: `https://registry.npmjs.org/${name}/-/${name}-${after}.tgz`, integrity: "sha512-fixture", license: "MIT" };
      lock.packages[target] = { version: before, inBundle: true, license: "MIT" };
      for (const path of [source, target]) {
        await mkdir(join(root, path), { recursive: true });
        await writeFile(join(root, path, "package.json"), JSON.stringify({ name, version: after }));
        await writeFile(join(root, path, "index.js"), "export const reviewed = true;\n");
      }
    }
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await callback(root, lock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("audit derives final package versions without changing the canonical lock or unrelated dependencies", async () => {
  await fixture(async (root, original) => {
    const before = await readFile(join(root, "package-lock.json"), "utf8");
    const { lock, replacements } = await createVerifiedAuditLock(root);
    assert.equal(replacements.length, 2);
    for (const { path, from, to } of replacements) {
      assert.equal(original.packages[path].version, from);
      assert.equal(lock.packages[path].version, to);
      assert.ok(lock.packages[path].integrity);
    }
    assert.deepEqual(lock.packages["node_modules/undici"], original.packages["node_modules/undici"]);
    assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), before);
  });
});

test("audit fails if an installed bundled dependency was not patched", async () => {
  await fixture(async root => {
    await writeFile(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json"), JSON.stringify({ name: "undici", version: "8.10.2" }));
    await assert.rejects(createVerifiedAuditLock(root), /Unpatched or unexpected undici/);
  });
});

test("matching versions alone cannot hide modified or additional runtime files", async () => {
  await fixture(async root => {
    await writeFile(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/index.js"), "unreviewed code");
    await assert.rejects(createVerifiedAuditLock(root), /differs from its integrity-locked replacement/);
  });
  await fixture(async root => {
    await writeFile(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/undici/extra.js"), "extra code");
    await assert.rejects(createVerifiedAuditLock(root), /differs from its integrity-locked replacement/);
  });
});

test("new source versions and unexpected upstream lock versions require review", async () => {
  for (const path of ["node_modules/undici", "node_modules/@earendil-works/pi-coding-agent/node_modules/undici"]) {
    await fixture(async (root, lock) => {
      lock.packages[path].version = "99.0.0";
      await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
      await assert.rejects(createVerifiedAuditLock(root), /Review the undici audit replacement/);
    });
  }
});

test("hoisted Pi dependencies stay verified and untracked nested copies are rejected", async () => {
  await fixture(async (root, lock) => {
    for (const name of ["brace-expansion", "undici"]) {
      const target = `node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`;
      delete lock.packages[target];
      await rm(join(root, target), { recursive: true });
    }
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    assert.deepEqual((await createVerifiedAuditLock(root)).replacements, []);
    const target = join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/undici");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), '{"name":"undici","version":"8.10.2"}');
    await assert.rejects(createVerifiedAuditLock(root), /Untracked bundled undici/);
    await rm(target, { recursive: true });
    await writeFile(join(root, "node_modules/undici/package.json"), '{"name":"undici","version":"8.10.2"}');
    await assert.rejects(createVerifiedAuditLock(root), /Unpatched or unexpected undici/);
  });
});
