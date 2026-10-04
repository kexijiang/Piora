import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { patchPiSourceProfile, verifyPiSourceProfile } from "../scripts/pi-source-profile.mjs";
import { verifyPiEmbeddedDependencies } from "../scripts/verify-pi-embedded-dependencies.mjs";
import { collectRuntimeDependencyAssets } from "../scripts/stage-standalone.mjs";

test("official unbundled Pi preserves public entries, isolated dependencies and strict integrity", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-pi-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = resolve("node_modules/@earendil-works/pi-coding-agent");
  const assets = await collectRuntimeDependencyAssets([original], process.cwd(), root);
  for (const asset of assets) await cp(asset.source, asset.destination, {
    recursive: true, filter: path => !path.split(/[\\/]/).includes(".bin"),
  });
  const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  assert.deepEqual(await verifyPiSourceProfile(root), { version: "1.0.2", effectiveUndici: "8.11.2", sourceFiles: 985 });
  assert.equal((await patchPiSourceProfile(root)).reason, "already-patched");
  assert.deepEqual(await verifyPiEmbeddedDependencies(root), []);
  for (const name of ["cli.js", "rpc-entry.js"]) {
    const child = spawnSync(process.execPath, [join(sdk, "dist/bundle", name), "--version"], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "1.0.2");
  }
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import * as publicSdk from './node_modules/@earendil-works/pi-coding-agent/dist/index.js';
    import * as launcherSdk from './node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js';
    import {createRequire} from 'node:module';
    import {getQuickJSWasmPath,getCodemodeWorkerSpecifier} from './node_modules/@earendil-works/pi-coding-agent/dist/config.js';
    import {existsSync} from 'node:fs';
    if (Object.keys(publicSdk).join()!==Object.keys(launcherSdk).join()) throw Error('SDK exports changed');
    if (!existsSync(getQuickJSWasmPath()) || getCodemodeWorkerSpecifier()!==undefined) throw Error('Worker profile changed');
    const require=createRequire(import.meta.url);
    const manifest=require(require.resolve('undici/package.json'));
    if(manifest.version!=='8.11.2') throw Error('Wrong effective Undici');
    console.log('SDK, WASM and dependency resolution verified');
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const entry = join(sdk, "dist/bundle/cli.js");
  const bytes = await readFile(entry);
  await writeFile(entry, Buffer.concat([bytes, Buffer.from("// unreviewed\n")]));
  await assert.rejects(patchPiSourceProfile(root), /Unexpected Pi source launcher/);
  await writeFile(entry, bytes);
  const source = join(sdk, "dist/core/http-dispatcher.js");
  const official = await readFile(source);
  await writeFile(source, Buffer.concat([official, Buffer.from("// changed\n")]));
  await assert.rejects(verifyPiSourceProfile(root), /differs from the verified official/);
  await writeFile(source, official);
  await writeFile(join(sdk, "dist/bundle/unreviewed.js"), 'var embedded={"node_modules/undici/index.js"(exports,module){}};');
  await assert.rejects(verifyPiEmbeddedDependencies(root), /Unverified embedded Undici/);
  await rm(join(sdk, "dist/bundle/unreviewed.js"));
  await rm(entry);
  await symlink(join(sdk, "dist/cli.js"), entry);
  await assert.rejects(verifyPiSourceProfile(root), /Unexpected Pi source launcher/);
});
