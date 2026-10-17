import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { satisfies } = require("next/dist/compiled/semver");
const root = new URL("../", import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), "utf8"));

for (const [manifestPath, lockPath, workspace] of [
  ["package.json", "package-lock.json", ""],
  ["desktop/package.json", "package-lock.json", "desktop"],
  ["website/package.json", "website/package-lock.json", ""],
]) {
  test(`${manifestPath} direct dependencies resolve to compatible locked versions`, async () => {
    const [manifest, lock] = await Promise.all([json(manifestPath), json(lockPath)]);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        assert.equal(lock.packages[workspace]?.[section]?.[name], spec,
          `${name}: manifest and workspace lock declaration must agree`);
        const nestedPath = workspace && `${workspace}/node_modules/${name}`;
        const installed = (nestedPath && lock.packages[nestedPath])
          || lock.packages[`node_modules/${name}`];
        assert.ok(installed, `${name}: direct dependency must have a lock entry`);
        const range = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec;
        assert.ok(satisfies(installed.version, range),
          `${name}: ${installed.version} shadows the declared ${spec}`);
      }
    }
  });
}
