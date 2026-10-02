import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateLicenseInventory } from "../scripts/generate-license-inventory.mjs";
import {
  generatePackageLicenseBundle,
  inspectPackagedNpmDependencies,
  inspectRuntimeSourceNpmDependencies,
} from "../scripts/package-license-bundle.mjs";

async function writePackage(root, relativePath, manifest, licenseFiles = {}) {
  const packageRoot = join(root, ...relativePath.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await Promise.all(
    Object.entries(licenseFiles).map(([name, contents]) =>
      writeFile(join(packageRoot, name), contents, "utf8"),
    ),
  );
}

test("source license inventory is deterministic and --check detects stale output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-license-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/alpha": { version: "1.0.0", license: "MIT" },
      "node_modules/holder/node_modules/alpha": {
        version: "1.0.0",
        license: "MIT",
        dev: true,
        optional: true,
      },
      "node_modules/legacy": { version: "2.0.0", dev: true },
    },
  };
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  await writeFile(join(root, "package-lock.json"), lockText, "utf8");
  const generated = await generateLicenseInventory({ projectRoot: root });
  assert.equal(generated.records.length, 2);
  assert.deepEqual(generated.records.find((entry) => entry.name === "alpha"), {
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
    runtime: true,
    optional: false,
  });
  const output = await readFile(join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
  assert.match(output, new RegExp(createHash("sha256").update(lockText).digest("hex")));
  assert.doesNotMatch(output, /Generated:\s/);
  assert.match(output, /`legacy` \| `2\.0\.0` \| UNDECLARED/);
  await generateLicenseInventory({ projectRoot: root, check: true });

  await writeFile(
    join(root, "package-lock.json"),
    lockText.replace(/\n/g, "\r\n"),
    "utf8",
  );
  await generateLicenseInventory({ projectRoot: root, check: true });

  await writeFile(join(root, "THIRD_PARTY_LICENSES.md"), `${output}\nmodified`, "utf8");
  await assert.rejects(
    generateLicenseInventory({ projectRoot: root, check: true }),
    /is stale/,
  );
});

test("source license inventory fails closed for an unreviewed runtime package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-license-unreviewed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/unreviewed-runtime": { version: "1.0.0" },
    },
  }, null, 2)}\n`, "utf8");
  await assert.rejects(
    generateLicenseInventory({ projectRoot: root }),
    /Runtime packages require a declared or version-scoped reviewed license: unreviewed-runtime@1\.0\.0/,
  );
});

test("packaged bundle inventories exact package copies and deduplicates complete license texts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-license-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "resources", "web");
  const outputRoot = join(root, "resources", "licenses");
  const sourceRoot = join(root, "source");
  await mkdir(webRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(webRoot, "package.json"), '{"name":"piora","version":"9.8.7"}\n', "utf8");
  const sharedLicense = "Complete shared license text.\nLine two.\n";
  const alphaManifest = {
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  };
  const holderManifest = {
    name: "holder",
    version: "3.0.0",
    license: "BSD-2-Clause",
  };
  const betaManifest = {
    name: "@scope/beta",
    version: "2.0.0",
    license: "Apache-2.0",
  };
  const bundledOnlyManifest = {
    name: "bundled-only",
    version: "4.0.0",
    license: "MIT",
  };
  const developmentOnlyManifest = {
    name: "development-only",
    version: "5.0.0",
    license: "ISC",
  };
  await writePackage(webRoot, "node_modules/alpha", alphaManifest);
  await writePackage(webRoot, "node_modules/holder", holderManifest);
  await writePackage(webRoot, "node_modules/holder/node_modules/@scope/beta", betaManifest);
  await writePackage(sourceRoot, "node_modules/alpha", alphaManifest, { LICENSE: sharedLicense });
  await writePackage(sourceRoot, "node_modules/holder", holderManifest);
  await writePackage(sourceRoot, "node_modules/holder/node_modules/@scope/beta", betaManifest, {
    "NOTICE.md": sharedLicense,
  });
  await writePackage(sourceRoot, "node_modules/bundled-only", bundledOnlyManifest, {
    COPYING: sharedLicense,
  });
  await writePackage(sourceRoot, "node_modules/development-only", developmentOnlyManifest, {
    LICENSE: "Development-only license text.\n",
  });
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "source",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "source", version: "1.0.0" },
      "node_modules/alpha": { version: "1.0.0" },
      "node_modules/holder": { version: "3.0.0" },
      "node_modules/holder/node_modules/@scope/beta": { version: "2.0.0" },
      "node_modules/bundled-only": { version: "4.0.0", license: "MIT" },
      "node_modules/development-only": { version: "5.0.0", license: "ISC", dev: true },
    },
  }, null, 2)}\n`, "utf8");

  const generated = await generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot });
  assert.equal(generated.packageCount, 3);
  assert.equal(generated.runtimeSourcePackageCount, 4);
  assert.equal(generated.uniqueLicenseTextCount, 1);
  const bundleRoot = join(outputRoot, "third-party");
  const manifestText = await readFile(join(bundleRoot, "THIRD_PARTY_PACKAGES.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.packageCount, 3);
  assert.equal(manifest.runtimeSourcePackageCount, 4);
  assert.equal(manifest.uniqueLicenseTextCount, 1);
  assert.equal(manifest.schema, "piora-third-party-packages-v3");
  assert.ok(manifest.packages.every((entry) => entry.scope === "packaged-node-modules"));
  assert.ok(
    manifest.runtimeSourceClosure.every((entry) => entry.scope === "runtime-source-closure"),
  );
  assert.ok(manifest.runtimeSourceClosure.some((entry) => entry.name === "bundled-only"));
  assert.ok(!manifest.packages.some((entry) => entry.name === "bundled-only"));
  assert.ok(!manifest.runtimeSourceClosure.some((entry) => entry.name === "development-only"));
  assert.equal(manifest.packages.filter((entry) => entry.licenseFiles.length > 0).length, 2);
  assert.doesNotMatch(manifestText, new RegExp(root.replaceAll("\\", "\\\\"), "i"));
  const sbom = JSON.parse(await readFile(join(bundleRoot, "SBOM.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.metadata.component.version, "9.8.7");
  assert.equal(sbom.components.length, 7);
  assert.equal(
    sbom.components.filter((entry) => (
      entry.properties.some((property) => (
        property.name === "Piora:evidenceScope" && property.value === "runtime-source-closure"
      ))
    )).length,
    4,
  );
  await generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot, check: true });

  await writeFile(join(sourceRoot, "node_modules", "alpha", "LICENSE"), "changed source license\n", "utf8");
  await assert.rejects(
    generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot, check: true }),
    /file set does not match/,
  );
  await writeFile(join(sourceRoot, "node_modules", "alpha", "LICENSE"), sharedLicense, "utf8");
  await generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot, check: true });

  const [licenseEntry] = manifest.packages.find((entry) => entry.name === "alpha").licenseFiles;
  assert.equal(
    await readFile(join(bundleRoot, ...licenseEntry.bundlePath.split("/")), "utf8"),
    sharedLicense,
  );
  await writeFile(join(bundleRoot, ...licenseEntry.bundlePath.split("/")), "tampered\n", "utf8");
  await assert.rejects(
    generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot, check: true }),
    /stale or modified/,
  );

  await generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot });
  await writeFile(join(bundleRoot, "unexpected.txt"), "unexpected\n", "utf8");
  await assert.rejects(
    generatePackageLicenseBundle({ webRoot, outputRoot, licenseSourceRoot: sourceRoot, check: true }),
    /file set does not match/,
  );
});

test("runtime source closure covers compiled UI dependencies and their published license material", async () => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const requiredPackages = [
    "@lobehub/icons",
    "format",
    "katex",
    "khroma",
    "mammoth",
    "mermaid",
    "opencc-js",
    "react-markdown",
    "react-syntax-highlighter",
    "rehype-katex",
    "rehype-raw",
    "rehype-sanitize",
    "remark-gfm",
    "remark-math",
  ];
  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(projectRoot, {
    packageNames: requiredPackages,
  });
  const packagesWithPublishedLicenseFiles = new Set([
    "@lobehub/icons",
    "katex",
    "mammoth",
    "mermaid",
    "opencc-js",
    "react-markdown",
    "react-syntax-highlighter",
    "rehype-raw",
    "rehype-sanitize",
    "remark-gfm",
  ]);
  const reviewedFallbacks = new Map([
    ["format", {
      commit: "91b6bd78af9b061c90010b86d83caa051edeb1ea",
      files: ["third_party/format/LICENSE.md", "third_party/format/SOURCE.md"],
    }],
    ["khroma", {
      commit: "4968165afb0d3d09be66497e7985a34f7bfe6d42",
      files: ["license", "third_party/khroma/LICENSE", "third_party/khroma/SOURCE.md"],
    }],
    ["rehype-katex", {
      commit: "88a9497e1ede93b958237c85edbf5651faeca7af",
      files: ["third_party/remark-math/LICENSE", "third_party/remark-math/SOURCE.md"],
    }],
    ["remark-math", {
      commit: "d5d0660b150810a535bbb07eac6cc96a4510aa24",
      files: ["third_party/remark-math/LICENSE", "third_party/remark-math/SOURCE.md"],
    }],
  ]);

  for (const name of requiredPackages) {
    const entry = runtimeSourceClosure.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} must be represented in runtime-source-closure`);
    assert.equal(entry.scope, "runtime-source-closure");
    assert.equal(entry.sourceInstalled, true, `${name} source package must be inspectable`);
    if (packagesWithPublishedLicenseFiles.has(name)) {
      assert.ok(entry.licenseFiles.length > 0, `${name} license text must be bundled`);
    } else {
      assert.equal(entry.licenseMaterialStatus, "reviewed-fallback");
      assert.equal(entry.declaredLicense, "MIT");
      assert.equal(entry.reviewedLicenseFallback.upstreamCommit, reviewedFallbacks.get(name).commit);
      assert.deepEqual(
        entry.licenseFiles.map((file) => file.sourceName).sort(),
        reviewedFallbacks.get(name).files,
      );
    }
  }
});

test("runtime source closure accepts bounded regular files in a published LICENSES directory", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "piora-license-directory-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writePackage(sourceRoot, "node_modules/directory-license", {
    name: "directory-license",
    version: "1.0.0",
    license: "Apache-2.0",
  });
  const licenseDirectory = join(sourceRoot, "node_modules", "directory-license", "LICENSES");
  await mkdir(licenseDirectory);
  await writeFile(join(licenseDirectory, "Apache-2.0.txt"), "Directory license text.\n", "utf8");
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/directory-license": { version: "1.0.0", license: "Apache-2.0" },
    },
  }, null, 2)}\n`, "utf8");

  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(sourceRoot, {
    packageNames: ["directory-license"],
  });
  assert.equal(runtimeSourceClosure.length, 1);
  assert.equal(runtimeSourceClosure[0].licenseMaterialStatus, "available");
  assert.deepEqual(
    runtimeSourceClosure[0].licenseFiles.map((file) => file.sourceName),
    ["LICENSES/Apache-2.0.txt"],
  );
});

test("runtime source closure resolves npm aliases and staged packages pruned by electron-builder", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "piora-license-staged-runtime-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(join(sourceRoot, "node_modules", "hypium-driver", "build"), { recursive: true });
  await writePackage(
    sourceRoot,
    ".next/standalone/node_modules/hypium-driver",
    { name: "hypium-driver", version: "6.1.0210", license: "ISC" },
  );
  await writePackage(
    sourceRoot,
    "node_modules/xmldom",
    { name: "@xmldom/xmldom", version: "0.9.12", license: "MIT" },
    { LICENSE: "Secure XML DOM license.\n" },
  );
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "source",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "source", version: "1.0.0" },
      "node_modules/hypium-driver": {
        version: "6.1.210",
        integrity: "sha512-YWvIWwl3tedNUV9FI2ZMD28AER+OXRofdvOe/v7sneOQcfrh3RPmzbAz2BKXi+VOXf4lj8HBOc4lRER0TCKjAw==",
        license: "ISC",
      },
      "node_modules/xmldom": {
        name: "@xmldom/xmldom",
        version: "0.9.12",
        license: "MIT",
      },
    },
  }, null, 2)}\n`, "utf8");

  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(sourceRoot, {
    packageNames: ["hypium-driver", "@xmldom/xmldom"],
  });
  assert.deepEqual(runtimeSourceClosure.map((entry) => entry.name), [
    "@xmldom/xmldom",
    "hypium-driver",
  ]);
  const hypium = runtimeSourceClosure.find((entry) => entry.name === "hypium-driver");
  assert.equal(hypium.version, "6.1.0210");
  assert.equal(hypium.sourceInstalled, true);
  assert.equal(hypium.licenseMaterialStatus, "not-published");
  assert.deepEqual(hypium.reviewedReplacements, [{
    lockPath: "node_modules/hypium-driver",
    lockedName: "hypium-driver",
    lockedVersion: "6.1.210",
    lockedIntegrity: "sha512-YWvIWwl3tedNUV9FI2ZMD28AER+OXRofdvOe/v7sneOQcfrh3RPmzbAz2BKXi+VOXf4lj8HBOc4lRER0TCKjAw==",
    installedName: "hypium-driver",
    installedVersion: "6.1.0210",
    mechanism: "published-tarball-manifest",
  }]);
  const xmlDom = runtimeSourceClosure.find((entry) => entry.name === "@xmldom/xmldom");
  assert.equal(xmlDom.sourceInstalled, true);
  assert.equal(xmlDom.licenseMaterialStatus, "available");
  assert.deepEqual(xmlDom.lockPaths, ["node_modules/xmldom"]);

  const packagedWebRoot = join(sourceRoot, "packaged-web");
  await mkdir(packagedWebRoot, { recursive: true });
  await writeFile(join(packagedWebRoot, "package.json"), '{"name":"piora","version":"1.0.0"}\n', "utf8");
  await writePackage(
    packagedWebRoot,
    "node_modules/hypium-driver",
    { name: "hypium-driver", version: "6.1.0210", license: "ISC" },
  );
  const packaged = await inspectPackagedNpmDependencies(packagedWebRoot, {
    licenseSourceRoot: sourceRoot,
  });
  assert.equal(
    packaged.packages.find((entry) => entry.name === "hypium-driver").version,
    "6.1.0210",
  );
  assert.equal(
    packaged.runtimeSourceClosure.find((entry) => entry.name === "hypium-driver").version,
    "6.1.0210",
  );

  const lockPath = join(sourceRoot, "package-lock.json");
  const tamperedLock = JSON.parse(await readFile(lockPath, "utf8"));
  tamperedLock.packages["node_modules/hypium-driver"].integrity = "sha512-tampered";
  await writeFile(lockPath, `${JSON.stringify(tamperedLock, null, 2)}\n`, "utf8");
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["hypium-driver"] }),
    /expected integrity .* found sha512-tampered/,
  );

  tamperedLock.packages["node_modules/hypium-driver"].version = "6.1.0210";
  tamperedLock.packages["node_modules/hypium-driver"].integrity =
    "sha512-YWvIWwl3tedNUV9FI2ZMD28AER+OXRofdvOe/v7sneOQcfrh3RPmzbAz2BKXi+VOXf4lj8HBOc4lRER0TCKjAw==";
  await writeFile(lockPath, `${JSON.stringify(tamperedLock, null, 2)}\n`, "utf8");
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["hypium-driver"] }),
    /expected hypium-driver@6\.1\.210 .* found hypium-driver@6\.1\.0210/,
  );
});

test("unused lobehub peer UI packages are absent from the committed dependency closure", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const name of ["@giscus/react", "@lobehub/ui", "@splinetool/runtime"]) {
    assert.equal(lock.packages[`node_modules/${name}`], undefined, `${name} must not be locked`);
  }
  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(
    fileURLToPath(new URL("../", import.meta.url)),
    { packageNames: ["@giscus/react", "@lobehub/ui", "@splinetool/runtime"] },
  );
  assert.deepEqual(runtimeSourceClosure, []);
});

test("reviewed postinstall replacement records only the final brace-expansion entity", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "piora-license-replacement-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const finalManifest = { name: "brace-expansion", version: "5.0.12", license: "MIT" };
  await writePackage(sourceRoot, "node_modules/brace-expansion", finalManifest, {
    LICENSE: "Reviewed final dependency license.\n",
  });
  const nestedPath = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  await writePackage(sourceRoot, nestedPath, finalManifest, {
    LICENSE: "Reviewed final dependency license.\n",
  });
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "source",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "source", version: "1.0.0" },
      "node_modules/brace-expansion": { version: "5.0.12", license: "MIT" },
      [nestedPath]: { version: "5.0.9", license: "MIT" },
    },
  }, null, 2)}\n`, "utf8");

  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(sourceRoot, {
    packageNames: ["brace-expansion"],
  });
  assert.equal(runtimeSourceClosure.length, 1);
  assert.equal(runtimeSourceClosure[0].version, "5.0.12");
  assert.deepEqual(runtimeSourceClosure[0].lockPaths, [nestedPath, "node_modules/brace-expansion"]);
  assert.deepEqual(runtimeSourceClosure[0].reviewedReplacements, [{
    lockPath: nestedPath,
    lockedName: "brace-expansion",
    lockedVersion: "5.0.9",
    installedName: "brace-expansion",
    installedVersion: "5.0.12",
    mechanism: "scripts/patch-bundled-dependencies.mjs",
  }]);

  await writePackage(sourceRoot, nestedPath, {
    name: "brace-expansion",
    version: "5.0.9",
    license: "MIT",
  });
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["brace-expansion"] }),
    /must contain brace-expansion@5\.0\.12, found brace-expansion@5\.0\.9/,
  );
});

test("reviewed postinstall replacement records only the final undici entity", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "piora-license-undici-replacement-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const finalManifest = { name: "undici", version: "8.11.2", license: "MIT" };
  await writePackage(sourceRoot, "node_modules/undici", finalManifest, {
    LICENSE: "Reviewed final dependency license.\n",
  });
  const nestedPath = "node_modules/@earendil-works/pi-coding-agent/node_modules/undici";
  await writePackage(sourceRoot, nestedPath, finalManifest, {
    LICENSE: "Reviewed final dependency license.\n",
  });
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "source",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "source", version: "1.0.0" },
      "node_modules/undici": { version: "8.11.2", license: "MIT" },
      [nestedPath]: { version: "8.10.2", license: "MIT" },
    },
  }, null, 2)}\n`, "utf8");

  const { runtimeSourceClosure } = await inspectRuntimeSourceNpmDependencies(sourceRoot, {
    packageNames: ["undici"],
  });
  assert.equal(runtimeSourceClosure.length, 1);
  assert.equal(runtimeSourceClosure[0].version, "8.11.2");
  assert.deepEqual(runtimeSourceClosure[0].lockPaths, [nestedPath, "node_modules/undici"]);
  assert.deepEqual(runtimeSourceClosure[0].reviewedReplacements, [{
    lockPath: nestedPath,
    lockedName: "undici",
    lockedVersion: "8.10.2",
    installedName: "undici",
    installedVersion: "8.11.2",
    mechanism: "scripts/patch-bundled-dependencies.mjs",
  }]);

  await writePackage(sourceRoot, nestedPath, {
    name: "undici",
    version: "8.10.2",
    license: "MIT",
  });
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["undici"] }),
    /must contain undici@8\.11\.2, found undici@8\.10\.2/,
  );
});

test("version-scoped remark-math license fallback is complete and tamper evident", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "piora-license-fallback-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writePackage(sourceRoot, "node_modules/rehype-katex", {
    name: "rehype-katex",
    version: "7.0.1",
    license: "MIT",
  });
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify({
    name: "source",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "source", version: "1.0.0" },
      "node_modules/rehype-katex": { version: "7.0.1", license: "MIT" },
    },
  }, null, 2)}\n`, "utf8");
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const fallbackRoot = join(sourceRoot, "third_party", "remark-math");
  await mkdir(join(sourceRoot, "third_party"), { recursive: true });
  await cp(join(repositoryRoot, "third_party", "remark-math"), fallbackRoot, { recursive: true });

  const inspected = await inspectRuntimeSourceNpmDependencies(sourceRoot, {
    packageNames: ["rehype-katex"],
  });
  assert.equal(inspected.runtimeSourceClosure[0].licenseMaterialStatus, "reviewed-fallback");
  assert.equal(inspected.runtimeSourceClosure[0].licenseFiles.length, 2);

  const webRoot = join(sourceRoot, "packaged-web");
  const outputRoot = join(sourceRoot, "packaged-licenses");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writePackage(webRoot, "node_modules/rehype-katex", {
    name: "rehype-katex",
    version: "7.0.1",
    license: "MIT",
  });
  const generated = await generatePackageLicenseBundle({
    webRoot,
    outputRoot,
    licenseSourceRoot: sourceRoot,
  });
  assert.equal(generated.uniqueLicenseTextCount, 2);
  const bundleManifest = JSON.parse(
    await readFile(join(outputRoot, "third-party", "THIRD_PARTY_PACKAGES.json"), "utf8"),
  );
  assert.equal(bundleManifest.packages[0].licenseMaterialStatus, "reviewed-fallback");
  assert.equal(
    bundleManifest.runtimeSourceClosure[0].reviewedLicenseFallback.upstreamCommit,
    "88a9497e1ede93b958237c85edbf5651faeca7af",
  );
  const sbom = JSON.parse(
    await readFile(join(outputRoot, "third-party", "SBOM.cdx.json"), "utf8"),
  );
  assert.equal(
    sbom.components.filter((component) => component.properties.some((property) => (
      property.name === "Piora:reviewedLicenseFallback"
    ))).length,
    2,
  );

  await writeFile(join(fallbackRoot, "LICENSE"), "tampered\n", "utf8");
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["rehype-katex"] }),
    /Reviewed fallback license is stale or modified/,
  );

  await cp(join(repositoryRoot, "third_party", "remark-math", "LICENSE"), join(fallbackRoot, "LICENSE"));
  const provenancePath = join(fallbackRoot, "SOURCE.md");
  const provenance = await readFile(provenancePath, "utf8");
  await writeFile(provenancePath, `${provenance}\nmodified\n`, "utf8");
  await assert.rejects(
    inspectRuntimeSourceNpmDependencies(sourceRoot, { packageNames: ["rehype-katex"] }),
    /Reviewed fallback provenance is stale or modified/,
  );
});

test("remark-math fallback pins the complete upstream MIT text and both package commits", async () => {
  const license = await readFile(
    new URL("../third_party/remark-math/LICENSE", import.meta.url),
  );
  const source = await readFile(
    new URL("../third_party/remark-math/SOURCE.md", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    "cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "72aab2559c65795359db5e65bbc370b88e54030cb94b52b0ff8b518697b1e90a",
  );
  assert.match(license.toString("utf8"), /Copyright \(c\) 2017 Junyoung Choi/);
  assert.match(source, /rehype-katex@7\.0\.1/);
  assert.match(source, /88a9497e1ede93b958237c85edbf5651faeca7af/);
  assert.match(source, /remark-math@6\.0\.0/);
  assert.match(source, /d5d0660b150810a535bbb07eac6cc96a4510aa24/);
});

test("format and khroma fallbacks pin reviewed MIT text and immutable provenance", async () => {
  const fixtures = [
    {
      directory: "format",
      licenseName: "LICENSE.md",
      licenseSha256: "0b2c94863590ca2aed327e89642b7e74b1608ec423bfec1d8f1beba2945fc4ba",
      sourceSha256: "fb937cd4b4290274e316281adb88163df6f58b20e1365c9ffc5ead1b902674e0",
      packagePattern: /format@0\.2\.2/,
      commitPattern: /91b6bd78af9b061c90010b86d83caa051edeb1ea/,
    },
    {
      directory: "khroma",
      licenseName: "LICENSE",
      licenseSha256: "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49",
      sourceSha256: "63cb2cbfe8f700e79fcf3facc3d850e225f4e20dd857a4e1f43ea423f285299c",
      packagePattern: /khroma@2\.1\.0/,
      commitPattern: /4968165afb0d3d09be66497e7985a34f7bfe6d42/,
    },
  ];
  for (const fixture of fixtures) {
    const root = new URL(`../third_party/${fixture.directory}/`, import.meta.url);
    const [license, source] = await Promise.all([
      readFile(new URL(fixture.licenseName, root)),
      readFile(new URL("SOURCE.md", root), "utf8"),
    ]);
    assert.equal(createHash("sha256").update(license).digest("hex"), fixture.licenseSha256);
    assert.equal(createHash("sha256").update(source).digest("hex"), fixture.sourceSha256);
    assert.match(source, fixture.packagePattern);
    assert.match(source, fixture.commitPattern);
    assert.match(source, new RegExp(fixture.licenseSha256));
  }
});

test("electron-builder is wired to generate licenses after the final web tree is copied", async () => {
  const config = await readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");
  const verifier = await readFile(new URL("../scripts/verify-packaged-web.mjs", import.meta.url), "utf8");
  assert.match(config, /^afterPack: \.\.\/scripts\/electron-after-pack-licenses\.cjs$/m);
  assert.match(config, /from: \.\.\/THIRD_PARTY_LICENSES\.md/);
  assert.match(config, /from: \.\.\/third_party\/openai-codex/);
  assert.match(config, /from: \.\.\/third_party\/openpets/);
  assert.match(verifier, /LICENSE\.electron\.txt/);
  assert.match(verifier, /LICENSES\.chromium\.html/);
  assert.match(verifier, /generatePackageLicenseBundle\(\{/);
  assert.match(verifier, /Packaged OpenAI Codex attribution is stale or modified/);
});

test("OpenAI Codex pet compatibility carries pinned Apache-2.0 attribution", async () => {
  const source = await readFile(
    new URL("../third_party/openai-codex/SOURCE.md", import.meta.url),
    "utf8",
  );
  const license = await readFile(
    new URL("../third_party/openai-codex/LICENSE", import.meta.url),
    "utf8",
  );
  const notice = await readFile(
    new URL("../third_party/openai-codex/NOTICE", import.meta.url),
    "utf8",
  );
  const adaptation = await readFile(
    new URL("companion-pets.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /775fb21d2af9b9936618fe22dd62e6f0cb3ba4a3/);
  assert.match(source, /catalog\.rs/);
  assert.match(source, /model\.rs/);
  assert.match(source, /asset_pack\.rs/);
  assert.match(source, /not an official OpenAI integration/);
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright 2025 OpenAI/);
  assert.match(notice, /OpenAI Codex/);
  assert.match(notice, /Ratatui/);
  assert.match(adaptation, /MODIFIED APACHE-2\.0 ADAPTATION NOTICE/);
  assert.match(adaptation, /Copyright 2025 OpenAI/);
  assert.match(adaptation, /third_party\/openai-codex\/SOURCE\.md/);
  assert.match(adaptation, /project as a whole\s+\* remains distributed under its existing MIT license/);
});

test("OpenPets adaptations and bundled assets carry pinned MIT attribution", async () => {
  const source = await readFile(
    new URL("../third_party/openpets/SOURCE.md", import.meta.url),
    "utf8",
  );
  const license = await readFile(
    new URL("../third_party/openpets/LICENSE", import.meta.url),
    "utf8",
  );
  const adaptation = await readFile(
    new URL("../components/DesktopCompanionWindow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /6855f9daa95dcdb19fe6caf6b0a28e2e578bb5e0/);
  assert.match(source, /d57f8b4b7312fb15cc123e76a3b9ac1bdedf4ad3/);
  assert.match(source, /OpenPetsHost\.swift/);
  assert.match(source, /No OpenPets executable/);
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 OpenPets/);
  assert.match(adaptation, /MODIFIED MIT ADAPTATION NOTICE/);
  assert.match(adaptation, /third_party\/openpets\/SOURCE\.md/);
});
