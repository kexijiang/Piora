/* eslint-disable @typescript-eslint/no-require-imports -- also runs in packaged Electron's Node mode. */
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");

const MANIFEST_PATH = "resources/portable-payload.json";
const READY_PATH = ".piora-runtime-ready";
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(root, allowReady = false) {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error("Payload root must be a regular directory");
  const files = [];
  const directories = [];
  async function visit(relative = "") {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === MANIFEST_PATH || (allowReady && path === READY_PATH)) continue;
      const entry = await lstat(join(root, path));
      if (entry.isSymbolicLink()) throw new Error(`Payload links are forbidden: ${path}`);
      if (entry.isDirectory()) { directories.push(path); await visit(path); }
      else if (entry.isFile()) files.push({ path, size: entry.size, sha256: await hashFile(join(root, path)) });
      else throw new Error(`Unsupported payload entry: ${path}`);
    }
  }
  await visit();
  return { files, directories };
}
async function createPayloadManifest(root, { version, executable }) {
  if (!version || basename(executable) !== executable || !executable.endsWith(".exe")) throw new Error("Invalid portable payload identity");
  await mkdir(join(root, "resources"), { recursive: true });
  const contents = await inventory(root);
  if (!contents.files.some(file => file.path === executable)) throw new Error("Portable executable missing");
  const manifest = { schema: 1, version, executable, ...contents };
  const encoded = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(join(root, MANIFEST_PATH), encoded);
  return encoded;
}
async function verifyPayload(root, manifestFile, version, { allowReady = false } = {}) {
  const expectedBytes = await readFile(manifestFile);
  const manifest = JSON.parse(expectedBytes);
  if (manifest.schema !== 1 || manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.directories)) throw new Error("Invalid portable payload manifest");
  const embedded = join(root, MANIFEST_PATH);
  if (!(await lstat(embedded)).isFile() || (await lstat(embedded)).isSymbolicLink() || !(await readFile(embedded)).equals(expectedBytes)) throw new Error("Embedded portable manifest mismatch");
  const actual = await inventory(root, allowReady);
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || JSON.stringify(actual.directories) !== JSON.stringify(manifest.directories)) throw new Error("Portable payload is missing, altered, or contains unexpected files");
  if (!actual.files.some(file => file.path === manifest.executable)) throw new Error("Portable executable missing from manifest");
  return manifest;
}
async function preparePublication(root, destination, manifestFile, version) {
  root = resolve(root);
  destination = resolve(destination);
  // Only this launcher's sibling staging/cache pair can be modified. No root,
  // parent, reparse-point or caller-selected unrelated cleanup is permitted.
  if (dirname(root) !== dirname(destination) || !basename(root).startsWith(`${basename(destination)}.pending-`) || root === destination || destination === dirname(destination)) throw new Error("Unsafe portable publication paths");
  for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error("Portable cache parents must not be links");
  }
  await verifyPayload(root, manifestFile, version);
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error("Portable destination must not be a link");
    await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // NSIS moves this whole directory only after this verifier process exits.
  // The marker is never visible in the reusable cache before all hashes pass.
  await writeFile(join(root, READY_PATH), version, { flag: "wx" });
}
module.exports = { MANIFEST_PATH, READY_PATH, createPayloadManifest, verifyPayload, preparePublication };
if (require.main === module) {
  const [mode, root, destination, manifestFile, version, diagnosticFile] = process.argv.slice(2);
  if (mode !== "prepare" || !root || !destination || !manifestFile || !version || ![7, 8].includes(process.argv.length)) {
    console.error("Expected: portable-payload.cjs prepare <staging> <destination> <manifest> <version> [diagnostic-file]");
    process.exitCode = 1;
  } else {
    preparePublication(root, destination, manifestFile, version).catch(async error => {
      // nsExec::ExecToStack captures stdout, not stderr. Keep filesystem/JSON
      // diagnostics bounded and avoid echoing payload contents or private paths.
      const reason = error instanceof SyntaxError ? "Invalid portable payload manifest JSON"
        : error.code ? `Portable payload filesystem operation failed: ${error.code}` : error.message;
      console.log(reason);
      process.exitCode = 1;
      // Some Windows console-less launches lose pipe output on process exit.
      // The launcher supplies a private fixed path as a second diagnostic channel.
      if (diagnosticFile) await writeFile(diagnosticFile, reason).catch(() => {});
    });
  }
}
