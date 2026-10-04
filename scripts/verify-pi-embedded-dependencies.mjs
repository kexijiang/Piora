import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Directory replacement and npm overrides cannot change already compiled
// dependency code. Until its provenance is independently verified, reject
// embedded Undici rather than treating the root package version as evidence.
export async function findUnverifiedPiEmbeddedDependencies(root) {
  const bundle = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
  const findings = [];
  async function visit(path) {
    const entry = await lstat(path).catch(error => {
      if (error.code === "ENOENT" && path === bundle) return undefined;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error(`Embedded dependency inspection refuses a symlink: ${path}`);
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (entry.isFile()) {
      if (!path.endsWith(".js")) return;
      const source = await readFile(path, "utf8");
      const modules = [...new Set([...source.matchAll(/"(node_modules\/undici\/[^"\n]+)"\s*\(/g)].map(match => match[1]))].sort();
      if (modules.length) findings.push({ path: relative(root, path).replaceAll("\\", "/"), name: "undici", modules });
    } else {
      throw new Error(`Embedded dependency inspection refuses a special entry: ${path}`);
    }
  }
  await visit(bundle);
  return findings;
}

export async function verifyPiEmbeddedDependencies(root) {
  const findings = await findUnverifiedPiEmbeddedDependencies(root);
  if (findings.length) {
    throw new Error(`Unverified embedded Undici in Pi bundle: ${findings.map(finding => finding.path).join(", ")}. Root overrides and directory patches do not cover these compiled bytes.`);
  }
  return findings;
}
