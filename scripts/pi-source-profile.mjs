import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const certificate = JSON.parse(await readFile(new URL("./pi-source-profile-1.0.2.json", import.meta.url), "utf8"));
export const piSourceLaunchers = Object.freeze({
  "cli.js": '#!/usr/bin/env node\n// Piora: official unbundled Pi; dependencies resolve through the reviewed lock.\nimport "../cli.js";\n',
  "rpc-entry.js": '#!/usr/bin/env node\n// Piora: official unbundled Pi; dependencies resolve through the reviewed lock.\nimport "../rpc-entry.js";\n',
  "index.js": '// Piora: official unbundled Pi; dependencies resolve through the reviewed lock.\nexport * from "../index.js";\n',
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sdkPath = root => join(root, "node_modules/@earendil-works/pi-coding-agent");

// Commitments are derived from the integrity-verified official npm tarball.
// Include every path and file byte, reject links/special files, and sort with
// JS string ordering (not platform locale). Empty directories do not contribute.
export async function piTreeCommitment(root, omitBundle = false) {
  const rows = [];
  async function visit(path, relative = "") {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Pi source profile refuses a symlink: ${path}`);
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (omitBundle && !relative && name === "bundle") continue;
        await visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
    } else if (entry.isFile()) rows.push(`${relative}\0${sha256(await readFile(path))}\n`);
    else throw new Error(`Pi source profile refuses a special entry: ${path}`);
  }
  await visit(root);
  rows.sort();
  return { files: rows.length, sha256: sha256(rows.join("")) };
}

async function verifyOfficialSource(root) {
  const sdk = sdkPath(root);
  for (const path of [join(root, "node_modules"), join(root, "node_modules/@earendil-works"), sdk, join(sdk, "package.json")]) {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) throw new Error(`Pi source profile refuses an unsafe entry: ${path}`);
  }
  const bytes = await readFile(join(sdk, "package.json"));
  const manifest = JSON.parse(bytes);
  if (manifest.name !== certificate.name || manifest.version !== certificate.version
    || sha256(bytes) !== certificate.packageJsonSha256) {
    throw new Error("Unexpected Pi package manifest; review the source profile before upgrading");
  }
  const commitment = await piTreeCommitment(join(sdk, "dist"), true);
  if (commitment.files !== certificate.unbundledDist.files || commitment.sha256 !== certificate.unbundledDist.sha256) {
    throw new Error("Pi unbundled distribution differs from the verified official npm package");
  }
  // Resolve from Pi, rather than accepting a root label while a nested copy wins.
  const requireFromPi = createRequire(join(sdk, "package.json"));
  const undici = JSON.parse(await readFile(join(dirname(requireFromPi.resolve("undici")), "package.json")));
  if (undici.name !== "undici" || undici.version !== certificate.effectiveUndici) {
    throw new Error(`Pi source profile requires effective undici ${certificate.effectiveUndici}`);
  }
  return sdk;
}

async function verifyLaunchers(sdk) {
  const bundle = join(sdk, "dist/bundle");
  const entry = await lstat(bundle);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Pi source launcher directory must be real");
  const names = (await readdir(bundle)).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(piSourceLaunchers).sort())) throw new Error("Unexpected Pi source launcher files");
  for (const [name, expected] of Object.entries(piSourceLaunchers)) {
    const path = join(bundle, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await readFile(path, "utf8") !== expected) {
      throw new Error(`Unexpected Pi source launcher: ${name}`);
    }
  }
}

export async function verifyPiSourceProfile(root) {
  const sdk = await verifyOfficialSource(root);
  await verifyLaunchers(sdk);
  return { version: certificate.version, effectiveUndici: certificate.effectiveUndici, sourceFiles: certificate.unbundledDist.files };
}

export async function patchPiSourceProfile(root) {
  const sdk = await verifyOfficialSource(root);
  const bundle = join(sdk, "dist/bundle");
  const commitment = await piTreeCommitment(bundle);
  if (commitment.files !== certificate.originalBundle.files || commitment.sha256 !== certificate.originalBundle.sha256) {
    await verifyLaunchers(sdk); // only the exact reviewed post-state is idempotent
    return { patched: false, reason: "already-patched", ...await verifyPiSourceProfile(root) };
  }
  // Keep bin/export paths and the official package manifest intact. The
  // official build:unbundled inputs already ship alongside the duplicate bundle.
  // No compiled dependency code is transplanted or relabeled.
  const temporary = join(sdk, "dist/.piora-source-launchers");
  await mkdir(temporary); // an unexpected prior directory is rejected
  try {
    for (const [name, source] of Object.entries(piSourceLaunchers)) {
      await writeFile(join(temporary, name), source, { mode: name === "index.js" ? 0o644 : 0o755, flag: "wx" });
    }
    await rm(bundle, { recursive: true });
    await rename(temporary, bundle);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { patched: true, ...await verifyPiSourceProfile(root) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify(await patchPiSourceProfile(root)));
}
