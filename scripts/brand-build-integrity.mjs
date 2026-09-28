import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function brandBuildFingerprint(root) {
  const files = [".branding/runtime.json", ".branding/builder.json", ".branding/builder-preview.json",
    "lib/generated/brand.ts", "desktop/src/generated/brand.ts", "app/favicon.ico", "public/offline.html",
    "public/icons/icon-192.png", "public/icons/icon-512.png", "public/icons/apple-touch-icon.png"];
  async function visit(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unexpected generated brand resource: ${path}`);
    }
  }
  await visit(".branding/resources");
  const hashes = [];
  for (const file of files.sort()) hashes.push([file, await hashFile(resolve(root, file))]);
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

const anchors = {
  web: [".next/BUILD_ID", ".next/standalone/.next/BUILD_ID"],
  desktop: ["desktop/dist/generated/brand.js"],
};

export async function recordBrandBuild(root, target, before) {
  if (!Object.hasOwn(anchors, target)) throw new Error("Unknown brand build target");
  if (await brandBuildFingerprint(root) !== before) throw new Error("Brand resources changed during compilation; rebuild both targets");
  const outputs = {};
  for (const file of anchors[target]) outputs[file] = await hashFile(resolve(root, file));
  if (target === "web" && new Set(Object.values(outputs)).size !== 1) throw new Error("Staged Web build does not match the compiled build");
  await writeFile(resolve(root, `.branding/${target}-build.json`), JSON.stringify({ fingerprint: before, outputs }));
}

export async function verifyBrandBuilds(root) {
  const fingerprint = await brandBuildFingerprint(root);
  for (const [target, files] of Object.entries(anchors)) {
    const stamp = JSON.parse(await readFile(resolve(root, `.branding/${target}-build.json`), "utf8"));
    if (stamp.fingerprint !== fingerprint) throw new Error(`${target} was compiled with different brand resources; run the complete build`);
    for (const file of files) {
      if (stamp.outputs?.[file] !== await hashFile(resolve(root, file))) throw new Error(`${target} output changed since its verified brand build`);
    }
  }
}
