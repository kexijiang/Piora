import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function brandReleaseGroups(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag)) throw new Error("Invalid release tag");
  const version = tag.slice(1);
  const preview = version.includes("-beta.");
  return ["piora"].flatMap(id => {
    const prefix = "Piora";
    const channel = `${preview ? "beta" : "latest"}.yml`;
    const groups = [{
      directory: `${id}-windows-${tag}`,
      checksum: "SHA256SUMS.txt",
      files: [`${prefix}-${version}-win-x64-setup.exe`, `${prefix}-${version}-win-x64-setup.exe.blockmap`, `${prefix}-${version}-win-x64-portable.exe`, channel,
        ...(!preview ? [`${prefix}-${version}-win-x64.zip`] : [])],
    }];
    if (!preview) groups.push({ directory: `${id}-linux-${tag}`, checksum: "SHA256SUMS-linux.txt", files: [`${prefix}-${version}-linux-x64-portable.AppImage`] });
    return groups;
  });
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Downloads must remain grouped by artifact. Flattening first can silently
// overwrite one brand's checksums/notes before they can be verified.
export async function assembleBrandRelease(input, output, tag, notesFile) {
  const groups = brandReleaseGroups(tag);
  const notes = await readFile(notesFile, "utf8");
  if (!notes.trim()) throw new Error("Release notes are empty");
  const files = new Map();
  for (const group of groups) {
    const directory = resolve(input, group.directory);
    const expected = new Set(group.files);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || (!expected.has(entry.name) && entry.name !== group.checksum && entry.name !== "release-notes.md")) {
        throw new Error(`Unexpected release artifact: ${group.directory}/${entry.name}`);
      }
    }
    const listed = new Map();
    const checksums = await readFile(resolve(directory, group.checksum), "utf8");
    for (const line of checksums.trim().split(/\r?\n/)) {
      const match = /^([0-9a-fA-F]{64})  ([^\\/]+)$/.exec(line);
      if (!match || !expected.has(match[2]) || listed.has(match[2])) throw new Error(`Invalid checksum entry in ${group.directory}`);
      listed.set(match[2], match[1].toLowerCase());
    }
    if (listed.size !== expected.size) throw new Error(`Incomplete checksums in ${group.directory}`);
    if (entries.some(entry => entry.name === "release-notes.md")) {
      const actual = await readFile(resolve(directory, "release-notes.md"), "utf8");
      if (actual.replaceAll("\r\n", "\n") !== notes.replaceAll("\r\n", "\n")) throw new Error(`Release notes mismatch in ${group.directory}`);
    }
    for (const name of expected) {
      if (files.has(name)) throw new Error(`Duplicate release filename: ${name}`);
      const source = resolve(directory, name);
      if (!(await lstat(source)).isFile()) throw new Error(`Not a regular release file: ${name}`);
      const hash = await digest(source);
      if (hash !== listed.get(name)) throw new Error(`Checksum mismatch: ${name}`);
      files.set(name, { source, hash });
    }
  }
  // Do not overwrite an existing release staging directory, even on retry.
  await mkdir(output);
  const sums = [];
  for (const [name, { source, hash }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    await copyFile(source, resolve(output, name));
    sums.push(`${hash}  ${name}`);
  }
  await writeFile(resolve(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  await writeFile(resolve(output, "release-notes.md"), notes);
  return [...files.keys()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, tag, notes] = process.argv.slice(2);
  if (!input || !output || !tag || !notes) throw new Error("Usage: assemble-brand-release.mjs <grouped-downloads> <new-output-directory> <tag> <canonical-notes>");
  const names = await assembleBrandRelease(input, output, tag, notes);
  console.log(`Verified and assembled ${names.length} release artifacts for ${tag}`);
}
