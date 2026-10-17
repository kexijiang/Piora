import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { brandBuildFingerprint, recordBrandBuild } from "./brand-build-integrity.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
if (!["web", "desktop"].includes(target)) throw new Error("Expected web or desktop build target");
await rm(resolve(root, `.branding/${target}-build.json`), { force: true });
const before = await brandBuildFingerprint(root);
const require = createRequire(import.meta.url);
const commands = target === "web"
  ? [[require.resolve("next/dist/bin/next"), "build", "--webpack"], [resolve(root, "scripts/stage-standalone.mjs")]]
  : [[resolve(require.resolve("@typescript/native/package.json"), "../lib/tsc.js"), "-p", "desktop/tsconfig.json"]];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await recordBrandBuild(root, target, before);
