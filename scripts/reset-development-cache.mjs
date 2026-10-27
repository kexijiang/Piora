import { lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = resolve(import.meta.dirname, "..");

/** Quarantine only generated dev output. rename never walks dependency links. */
export async function resetDevelopmentCache(root = sourceRoot) {
  const parent = resolve(root, ".next");
  const source = resolve(parent, "dev");
  for (const directory of [parent, source]) {
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing to move linked development directory: ${directory}`);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const destination = resolve(parent, `dev-stale-${Date.now()}-${randomUUID().slice(0, 8)}`);
  try { await rename(source, destination); }
  catch (error) { throw new Error("Cannot reset development output. Stop the dev server before retrying.", { cause: error }); }
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  resetDevelopmentCache().then(destination => console.log(destination
    ? `Development output preserved at ${destination}. Run npm run dev:desktop to regenerate it.`
    : "No development output to reset."))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
