import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";

// Reproduce only the explicitly pinned native assets; no latest-version lookup.
const root = new URL("../third_party/harmony-video/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let archive;
if (process.argv[2]) archive = await readFile(process.argv[2]);
else {
  const response = await fetch(manifest.source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Pinned video source returned HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
if (sha256(archive) !== manifest.sourceSha256) throw new Error("Pinned video source checksum mismatch");
const zip = await JSZip.loadAsync(archive);
const assets = await Promise.all(manifest.assets.map(async asset => {
  if (!/^libscrcpy_server_unix_\d+\.\d+-\d{8}\.z\.so$/.test(asset.name)) throw new Error("Invalid native asset name");
  const entry = zip.file(`libscrcpy/${asset.name}`);
  if (!entry) throw new Error(`Missing native asset: ${asset.name}`);
  const bytes = await entry.async("nodebuffer");
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`Native asset checksum mismatch: ${asset.name}`);
  return { asset, bytes };
}));
for (const { asset, bytes } of assets) {
  await writeFile(new URL(asset.name, root), bytes);
  process.stdout.write(`${asset.name} ${asset.sha256}\n`);
}
