import { mkdir, readFile, writeFile, rename, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { x } from "tar";
import { download, NPM_VERSION, NPM_INTEGRITY, petEnvironment, removePetDirectory } from "./dsh-pet-install.js";
import { petNetwork, petDispatcher, preparePetNetwork, type PetNetwork, type PetProxySettings } from "./dsh-pet-network.js";
import type { DshPetProgress } from "./dsh-pet-types.js";
export const DSH_MEME_VERSION = "0.1.76";
export const DSH_MEME_INTEGRITY = "ERxG9vDAe/TSChLKDeIiwqJIW5UYElQdkMZ3jSgZX+INYs0nMHCRlGNrjZKF5uXL0EI10IPJWfjE0LoVQczwJQ==";
export function memeNetwork(environment: NodeJS.ProcessEnv = process.env, proxy?: PetProxySettings): PetNetwork {
  const env = { ...environment };
  // Do not inherit a Pet-specific registry override.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "piora_dsh_pet_registry") delete env[key];
  const key = Object.keys(env).find(key => key.toLowerCase() === "piora_dsh_meme_registry");
  if (key && env[key]) env.PIORA_DSH_PET_REGISTRY = env[key];
  return petNetwork(env, proxy);
}
export async function installMeme(root: string, signal: AbortSignal, progress: (value: DshPetProgress) => void, network = memeNetwork()): Promise<void> {
  const staging = join(root, "staging");
  await removePetDirectory(root, staging);
  await mkdir(join(staging, "npm"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  network = await preparePetNetwork(root, network);
  const dispatcher = petDispatcher(network);
  try {
    await writeFile(join(root, "npmrc"), `registry=${network.registry}\n`);
    await writeFile(join(root, "npmrc-global"), "");
    await download(new URL(`npm/-/npm-${NPM_VERSION}.tgz`, network.registry).href, join(staging, "npm.tgz"), NPM_INTEGRITY, 20 * 1024 * 1024, signal,
      (received, total) => progress({ stage: "installer", received, total }), dispatcher);
    await x({ file: join(staging, "npm.tgz"), cwd: join(staging, "npm"), strip: 1,
      filter: (name, entry) => !name.split(/[\\/]/).includes("..") && "type" in entry && ["File", "Directory"].includes(entry.type) });
    await download(new URL(`dsh-meme/-/dsh-meme-${DSH_MEME_VERSION}.tgz`, network.registry).href, join(staging, "meme.tgz"), DSH_MEME_INTEGRITY, 20 * 1024 * 1024, signal,
      (received, total) => progress({ stage: "package", received, total }), dispatcher);
    await writeFile(join(staging, "package.json"), JSON.stringify({ name: "piora-dsh-meme-runtime", private: true, overrides: { sharp: "0.35.5" } }));
    progress({ stage: "dependencies", received: 0, total: null });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(staging, "npm", "bin", "npm-cli.js"), "install", "./meme.tgz", "--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--no-audit", "--no-fund", "--workspaces=false"],
        { cwd: staging, env: petEnvironment(root, process.env, network), windowsHide: true, stdio: ["ignore", "ignore", "pipe"], signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]) });
      let failure: Error | undefined;
      child.stderr?.resume(); // Do not expose npm proxy credentials through error output.
      child.once("error", error => { failure = error; if (!child.pid) reject(error); });
      child.once("close", code => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`DSH Meme dependencies failed (${code}); check registry, proxy and CA settings`)));
    });
    signal.throwIfAborted();
    const pkg = JSON.parse(await readFile(join(staging, "node_modules", "dsh-meme", "package.json"), "utf8"));
    if (pkg.version !== DSH_MEME_VERSION) throw new Error("Unexpected DSH Meme version");
    // Only this pinned plugin's declarative defineTool contract is implemented.
    const shim = join(staging, "node_modules", "@deepseek-ai", "dsh-tools");
    await mkdir(shim, { recursive: true });
    await writeFile(join(shim, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-tools", type: "module", exports: "./index.js", private: true }));
    await writeFile(join(shim, "index.js"), "export function defineTool(tool) { return tool; }\n");
    await writeFile(join(staging, "piora-adapter.json"), JSON.stringify({ version: DSH_MEME_VERSION, adapter: 1, integrity: DSH_MEME_INTEGRITY }));
    await rename(staging, join(root, "installed"));
  } finally { await dispatcher.destroy(); await removePetDirectory(root, staging); }
}

/** Pin-checked adaptation: editable bundled indices must survive uninstall/reinstall. */
export async function prepareMemeRuntime(root: string): Promise<void> {
  const pkg = join(root, "installed", "node_modules", "dsh-meme");
  const target = join(root, "home", "bundled-memes");
  if (!existsSync(target)) {
    const staging = join(root, "bundled-staging");
    await removePetDirectory(root, staging);
    await cp(join(pkg, "memes"), staging, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await rename(staging, target);
  }
  const file = join(pkg, "memes.js");
  const source = await readFile(file, "utf8");
  const anchor = "return fileURLToPath(new URL('./memes', import.meta.url))";
  const replacement = "return join(process.env.DSH_MEME_HOME, 'bundled-memes') // Piora: persistent bundled library";
  if (source.includes(replacement)) return;
  if (source.split(anchor).length !== 2) throw new Error("Unsupported dsh-meme bundled library layout");
  await writeFile(file + ".tmp", source.replace(anchor, replacement)); await rename(file + ".tmp", file);
}
