import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVerifiedAuditLock } from "../scripts/audit-runtime-dependencies.mjs";

const reviewedForgeRsa = await readFile(new URL("../node_modules/node-forge/lib/rsa.js", import.meta.url));

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "piora-audit-test-"));
  const lock = { lockfileVersion: 3, packages: { "": { name: "fixture" } } };
  try {
    for (const [name, before, after] of [["brace-expansion", "5.0.9", "5.0.12"], ["undici", "8.9.0", "8.11.2"]]) {
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
    const forgePath = "node_modules/node-forge";
    lock.packages[forgePath] = {
      version: "1.4.0",
      resolved: "https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz",
      integrity: "sha512-fixture",
      license: "(BSD-3-Clause OR GPL-2.0)",
    };
    await mkdir(join(root, forgePath, "lib"), { recursive: true });
    await writeFile(join(root, forgePath, "package.json"), JSON.stringify({ name: "node-forge", version: "1.4.0" }));
    await writeFile(join(root, forgePath, "lib", "rsa.js"), reviewedForgeRsa);
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await callback(root, lock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("audit derives final package versions without changing the canonical lock or unrelated dependencies", async () => {
  await fixture(async (root, original) => {
    const before = await readFile(join(root, "package-lock.json"), "utf8");
    const { lock, replacements, nodeForgePatch } = await createVerifiedAuditLock(root);
    assert.equal(replacements.length, 2);
    for (const { path, from, to } of replacements) {
      assert.equal(original.packages[path].version, from);
      assert.equal(lock.packages[path].version, to);
      assert.ok(lock.packages[path].integrity);
    }
    assert.deepEqual(lock.packages["node_modules/undici"], original.packages["node_modules/undici"]);
    assert.equal(lock.packages["node_modules/node-forge"].version, "1.4.1-piora.1");
    assert.equal(original.packages["node_modules/node-forge"].version, "1.4.0");
    assert.equal(nodeForgePatch.rsaSha256, "18ae286c1ef8e00fc6359ffe3280416946c1dfd6684c98c1c6af1590d7f7e9f4");
    assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), before);
  });
});

test("audit fails if an installed bundled dependency was not patched", async () => {
  await fixture(async root => {
    await writeFile(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json"), JSON.stringify({ name: "undici", version: "8.9.0" }));
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
  await fixture(async root => {
    await writeFile(join(root, "node_modules/node-forge/lib/rsa.js"), "unreviewed RSA verification code");
    await assert.rejects(createVerifiedAuditLock(root), /reviewed DigestAlgorithm patch/);
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
