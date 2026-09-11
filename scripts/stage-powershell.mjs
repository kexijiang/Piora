import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import extract from "@electron-internal/extract-zip";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EnvHttpProxyAgent, fetch } from "undici";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const powershellManifest = JSON.parse(await readFile(join(projectRoot, "third_party/powershell/manifest.json"), "utf8"));
const requiredFiles = ["pwsh.exe", "pwsh.dll", "pwsh.runtimeconfig.json", "System.Management.Automation.dll", "coreclr.dll", "hostfxr.dll", "hostpolicy.dll", "LICENSE.txt", "ThirdPartyNotices.txt"];

export async function verifyPowerShellArchive(archive, expected = powershellManifest.sha256) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error("PowerShell archive SHA-256 does not match the pinned Microsoft release");
}

export async function verifyStagedPowerShell(directory) {
  for (const name of [...requiredFiles, "bootstrap.cjs", "piora-manifest.json"]) await access(join(directory, name));
  const manifest = JSON.parse(await readFile(join(directory, "piora-manifest.json"), "utf8"));
  if (manifest.version !== powershellManifest.version || manifest.sha256 !== powershellManifest.sha256) throw new Error("Bundled PowerShell version does not match the source manifest");
  const runtime = JSON.parse(await readFile(join(directory, "pwsh.runtimeconfig.json"), "utf8"));
  if (!runtime.runtimeOptions?.includedFrameworks?.length || runtime.runtimeOptions.framework || runtime.runtimeOptions.frameworks) throw new Error("PowerShell must include its .NET runtime, not require a system installation");
}

export async function verifyPowerShellProcess(directory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (["path", "psmodulepath", "dotnet_root", "dotnet_root_x64"].includes(key.toLowerCase())) delete env[key];
  Object.assign(env, { PATH: join(process.env.SystemRoot || "C:\\Windows", "System32"), POWERSHELL_UPDATECHECK: "Off", POWERSHELL_TELEMETRY_OPTOUT: "1" });
  const { stdout } = await promisify(execFile)(join(directory, "pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "@{version=$PSVersionTable.PSVersion.ToString();home=$PSHOME;edition=$PSVersionTable.PSEdition} | ConvertTo-Json -Compress"], { env, windowsHide: true, timeout: 30_000 });
  const result = JSON.parse(stdout.trim());
  if (result.version !== powershellManifest.version || result.edition !== "Core" || resolve(result.home).toLowerCase() !== resolve(directory).toLowerCase()) throw new Error(`Bundled PowerShell probe failed: ${stdout}`);
  return result;
}

async function removeOwned(root, target) {
  const within = relative(resolve(root), resolve(target));
  if (!within || within === ".." || within.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) || isAbsolute(within)) throw new Error("Unsafe PowerShell staging cleanup path");
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function stagePowerShell(root = projectRoot) {
  const build = join(root, "desktop/build");
  await mkdir(build, { recursive: true });
  const temporary = await mkdtemp(join(build, ".powershell-"));
  const archive = join(temporary, powershellManifest.asset);
  const extracted = join(temporary, "runtime");
  const destination = join(build, "powershell");
  const dispatcher = new EnvHttpProxyAgent();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(powershellManifest.url, { signal: AbortSignal.timeout(300_000), dispatcher });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`PowerShell download failed: HTTP ${response.status}`); }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "w" }));
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.warn(`PowerShell download interrupted; retrying (${attempt}/3)`);
      }
    }
    await verifyPowerShellArchive(archive);
    await extract(archive, { dir: extracted });
    await copyFile(join(projectRoot, "scripts/powershell-bootstrap.cjs"), join(extracted, "bootstrap.cjs"));
    await writeFile(join(extracted, "piora-manifest.json"), JSON.stringify(powershellManifest, null, 2) + "\n");
    await verifyStagedPowerShell(extracted);
    if (process.platform === "win32") await verifyPowerShellProcess(extracted);
    await removeOwned(build, destination);
    await rename(extracted, destination);
    return destination;
  } finally { await dispatcher.destroy(); await removeOwned(build, temporary); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stagePowerShell().then(directory => console.log(`Staged PowerShell ${powershellManifest.version}: ${directory}`)).catch(error => { console.error(error); process.exitCode = 1; });
}
