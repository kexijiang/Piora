import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createVerificationTimings } from "./verification-timing.mjs";
import { verificationTempRoot } from "./verification-temp.mjs";

const timings = createVerificationTimings("windows-artifacts");

export function isWindowsVerificationContext(platform, tag, brand, prefix) {
  return platform === "win32" && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag ?? "")
    && /^[a-z0-9-]+$/.test(brand ?? "") && /^[A-Za-z0-9_-]+$/.test(prefix ?? "");
}

export async function runInParallel(tasks) {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, `Preview artifact validation failed in ${failures.length} branch(es)`);
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${executable} failed (${code ?? signal})`)));
  });
}

async function main() {
  const { GITHUB_REF_NAME: tag, PIORA_BRAND: brand, BRAND_PREFIX: prefix } = process.env;
  if (!isWindowsVerificationContext(process.platform, tag, brand, prefix)) {
    throw new Error("Invalid Windows preview verification context");
  }
  const version = tag.slice(1);
  const releaseRoot = resolve("desktop/release");
  const unpacked = join(releaseRoot, "win-unpacked", "Piora.exe");
  const installer = join(releaseRoot, `${prefix}-${version}-win-x64-setup.exe`);
  const extractor = resolve("desktop/build/portable-extractor/7za.exe");
  await Promise.all([access(unpacked), access(installer), access(extractor)]);
  const tempRoot = verificationTempRoot();
  const installDirectory = await mkdtemp(join(tempRoot, "piora-preview-install-"));
  const tempRelative = relative(tempRoot, installDirectory);
  if (!tempRelative || tempRelative.startsWith("..") || isAbsolute(tempRelative)) throw new Error("Unsafe preview install directory");
  const node = process.execPath;
  const script = (...args) => run(node, args);
  try {
    await runInParallel([
      () => timings.measure("packaged-web-total", () => script("scripts/verify-packaged-web.mjs")),
      async () => {
        await timings.measure("payload-regressions", () => run(node, ["--test", "lib/portable-payload.test.mjs"], { env: { ...process.env, PIORA_TEST_7ZA: extractor } }));
        await timings.measure("unpacked-smoke", () => script("scripts/smoke-test-portable.mjs", unpacked, "--expected-version", tag, "--packaged-runtime", "--expected-brand", brand));
        await timings.measure("nsis-install", () => run(installer, ["/S", `/D=${installDirectory}`], { windowsVerbatimArguments: true }), { installDirectory });
        const installed = join(installDirectory, "Piora.exe");
        await access(installed);
        await timings.measure("installed-smoke", () => script("scripts/smoke-test-portable.mjs", installed, "--expected-version", tag, "--packaged-runtime", "--expected-brand", brand));
        await timings.measure("electron-payload-integrity", () => script("scripts/verify-portable-runtime.mjs", join(releaseRoot, "win-unpacked"), tag));
      },
    ]);
  } finally {
    await timings.measure("cleanup-installed-app", () => rm(installDirectory, { recursive: true, force: true, maxRetries: 3 }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    if (error instanceof AggregateError) for (const failure of error.errors) console.error(failure);
    process.exitCode = 1;
  });
}
