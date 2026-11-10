import { tmpdir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contains = (root, child) => {
  const value = relative(root, child);
  return !value || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

export function verificationTempRoot(environment = process.env, systemTemp = tmpdir(), project = checkout) {
  const supplied = environment.CI === "true" ? environment.RUNNER_TEMP : undefined;
  if (!supplied) return resolve(systemTemp);
  if (!isAbsolute(supplied)) throw new Error("RUNNER_TEMP must be absolute");
  const root = resolve(supplied);
  if (root === parse(root).root || contains(project, root) || contains(root, project)) {
    throw new Error("Verification temporary root must be isolated from the checkout");
  }
  return root;
}

export function assertVerificationDirectory(directory, roots = [verificationTempRoot()]) {
  const path = resolve(directory);
  if (!roots.some(root => path !== resolve(root) && contains(resolve(root), path))) {
    throw new Error(`Unsafe verification directory: ${path}`);
  }
  return path;
}
