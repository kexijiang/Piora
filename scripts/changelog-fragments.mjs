#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = "changelog.d";
const types = { feature: "新增", fix: "修复", change: "改进", internal: "工程", skip: null };
const filename = /^([a-z0-9][a-z0-9-]*)\.(feature|fix|change|internal|skip)\.md$/;
const normalize = text => text.replace(/\r\n/g, "\n");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export function parseFragment(name, text) {
  const match = filename.exec(name);
  if (!match) throw new Error(`Invalid fragment filename: ${name}`);
  const body = normalize(text).trim();
  // Only bullet paragraphs: headings could break version extraction downstream.
  if (!body || !body.split("\n").every(line => !line.trim() || /^- \S/.test(line))) {
    throw new Error(`${name}: write non-empty '- ' bullet lines (no headings or conflict markers).`);
  }
  if (match[2] === "skip" && body.replace(/^- /gm, "").trim().length < 12) {
    throw new Error(`${name}: an exemption requires a concrete reason (at least 12 characters).`);
  }
  return { name, type: match[2], body };
}

export async function readFragments(root) {
  let entries;
  try { entries = await readdir(resolve(root, directory)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const name of entries.sort()) {
    if (name === "README.md") continue;
    const path = resolve(root, directory, name);
    if (!(await lstat(path)).isFile()) throw new Error(`Fragment must be a regular file: ${name}`);
    result.push(parseFragment(name, await readFile(path, "utf8")));
  }
  return result;
}

function snapshot(root, ref) {
  const entries = git(root, ["ls-tree", "-r", "-z", ref, "--", directory]).split("\0").filter(Boolean);
  return entries.flatMap(entry => {
    const [meta, path] = entry.split("\t");
    if (path === `${directory}/README.md`) return [];
    if (!meta.startsWith("100644 blob ") && !meta.startsWith("100755 blob ")) {
      throw new Error(`Fragment must be a regular file: ${path}`);
    }
    return [parseFragment(path.slice(directory.length + 1), git(root, ["show", `${ref}:${path}`]))];
  });
}

export function renderRelease(changelog, fragments, version, date) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error("Version must be X.Y.Z or X.Y.Z-beta.N (without v).");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("Supply a real release date as YYYY-MM-DD.");
  }
  const source = normalize(changelog);
  if (source.split("\n").some(line => line.startsWith(`## [${version}]`))) throw new Error(`Version ${version} already exists.`);
  const marker = /^## \[Unreleased\][ \t]*\n/gm;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1) throw new Error("Expected exactly one Unreleased heading.");
  const start = matches[0].index + matches[0][0].length;
  const remainder = source.slice(start);
  const next = remainder.search(/^## \[/m);
  const legacy = (next < 0 ? remainder : remainder.slice(0, next)).trim();
  const groups = Object.entries(types).filter(([, title]) => title).flatMap(([type, title]) => {
    const rows = fragments.filter(f => f.type === type).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return rows.length ? [`### ${title}\n\n${rows.map(f => f.body).join("\n")}`] : [];
  });
  const notes = [legacy, ...groups].filter(Boolean).join("\n\n");
  if (!notes) throw new Error("No publishable notes; exemption reasons alone cannot form a release.");
  return `${source.slice(0, start)}\n## [${version}] - ${date}\n\n${notes}\n\n${next < 0 ? "" : remainder.slice(next)}`;
}

export async function prepareRelease(root, version, date, write = false) {
  // Capture committed inputs only. Untracked/modified fragments must never be silently consumed.
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all", "--", "CHANGELOG.md", directory]);
  if (dirty.trim()) throw new Error("Commit CHANGELOG.md and changelog.d changes before preparing a release.");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const fragments = snapshot(root, head);
  const original = git(root, ["show", `${head}:CHANGELOG.md`]);
  const output = renderRelease(original, fragments, version, date);
  if (write) {
    if (git(root, ["rev-parse", "HEAD"]).trim() !== head || git(root, ["status", "--porcelain", "--untracked-files=all", "--", "CHANGELOG.md", directory]).trim()) {
      throw new Error("Release inputs changed; retry from a fixed snapshot.");
    }
    // Write notes first: an interrupted deletion leaves recoverable input, never lost notes.
    await writeFile(resolve(root, "CHANGELOG.md"), output);
    for (const fragment of fragments) await unlink(resolve(root, directory, fragment.name));
  }
  return { head, output, consumed: fragments.map(f => f.name) };
}

export function checkPullRequest(root, baseRef, headRef = "HEAD") {
  const baseCommit = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const head = git(root, ["rev-parse", "--verify", `${headRef}^{commit}`]).trim();
  const base = git(root, ["merge-base", baseCommit, head]).trim();
  const before = snapshot(root, base);
  const after = snapshot(root, head);
  const previous = new Map(before.map(f => [f.name, f]));
  const current = new Map(after.map(f => [f.name, f]));
  const added = after.filter(f => !previous.has(f.name));
  const removed = before.filter(f => !current.has(f.name));
  for (const f of after) {
    if (previous.has(f.name) && previous.get(f.name).body !== f.body) throw new Error(`Merged fragment is immutable: ${f.name}. Add a correction fragment instead.`);
  }
  const oldLog = normalize(git(root, ["show", `${base}:CHANGELOG.md`]));
  const newLog = normalize(git(root, ["show", `${head}:CHANGELOG.md`]));
  if (newLog !== oldLog || removed.length) {
    const heading = /^## \[(\d+\.\d+\.\d+(?:-beta\.\d+)?)\] - (\d{4}-\d{2}-\d{2})$/m.exec(newLog);
    if (!heading || renderRelease(oldLog, removed, heading[1], heading[2]) !== newLog) {
      throw new Error("CHANGELOG.md may only change through release aggregation; move ordinary PR notes into changelog.d.");
    }
    return { kind: "release", consumed: removed.length, added: added.length };
  }
  if (!added.length) throw new Error("Add a changelog.d fragment, or a unique .skip.md fragment explaining the exemption.");
  return { kind: "change", added: added.length };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === "check" && !args.length) {
    console.log(`Validated ${(await readFragments(root)).length} changelog fragments.`);
  } else if (command === "check-pr" && args.length >= 1 && args.length <= 2) {
    console.log(JSON.stringify(checkPullRequest(root, ...args)));
  } else if (command === "release" && (args.length === 2 || (args.length === 3 && args[2] === "--write"))) {
    const result = await prepareRelease(root, args[0], args[1], args[2] === "--write");
    console.log(args[2] ? `Wrote CHANGELOG.md from ${result.head}; consumed ${result.consumed.length} fragments.` : result.output);
  } else {
    throw new Error("Usage: changelog-fragments.mjs check | check-pr <base-ref> [head-ref] | release <version> <YYYY-MM-DD> [--write]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
