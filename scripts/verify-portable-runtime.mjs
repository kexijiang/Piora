#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePortableVersion } from "./verify-portable-artifact.mjs";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Exercise the exact filesystem runtime used by the portable bootstrap. */
export async function verifyPortableRuntime(root, version, { executable = join(root, "Piora.exe"), timeoutMs = 180000 } = {}) {
  const directory = resolve(root);
  const manifest = join(directory, "resources", "portable-payload.json");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  const probe = `if(!process.versions.electron)throw Error('Packaged Electron is required');
    require(process.argv[1]).verifyPayload(process.argv[2],process.argv[3],process.argv[4]).then(manifest=>{
      console.log(JSON.stringify({verified:true,electron:process.versions.electron,version:manifest.version,files:manifest.files.length}));
    }).catch(error=>{console.error(error.message);process.exitCode=1});`;
  const result = await run(resolve(executable), ["-e", probe, join(projectRoot, "scripts", "portable-payload.cjs"), directory, manifest, version], {
    env, cwd: projectRoot, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(result.stdout.trim());
  if (report.verified !== true || report.version !== version || !report.electron || !Number.isInteger(report.files) || report.files < 1) {
    throw new Error("Packaged Electron did not verify the complete portable manifest");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (!directory || !version) throw new Error("Usage: verify-portable-runtime.mjs <unpacked-directory> <version-or-tag>");
    return verifyPortableRuntime(directory, normalizePortableVersion(version));
  }).then(report => console.log(JSON.stringify(report))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
