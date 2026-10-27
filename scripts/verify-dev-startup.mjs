// Real dev-server benchmark. Each run uses an independent, initially empty
// Next output directory and agent directory; no production build is invoked.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const bundler = process.argv.includes("--webpack") ? "webpack" : "turbopack";
const port = Number(process.env.PIORA_BENCHMARK_PORT ?? 30151);
const directory = resolve(root, ".verification", `dev-startup-${bundler}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "tsconfig.json"), JSON.stringify({
  extends: relative(directory, resolve(root, "tsconfig.json")).replaceAll("\\", "/"),
  include: ["../../**/*.ts", "../../**/*.tsx"],
}));
const started = performance.now();
let child, browser;
let output = "";

function run(args, options = {}) {
  return spawn(process.execPath, args, { cwd: root, windowsHide: true, ...options });
}
async function prepare(args) {
  const process = run(args, { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Preparation exited ${code}`)));
  });
}
try {
  if (bundler === "webpack") {
    await prepare([resolve(root, "scripts/prepare-branding.mjs")]);
    await prepare([resolve(require.resolve("@typescript/native/package.json"), "../lib/tsc.js"), "-p", "tsconfig.harmony-worker.json"]);
  } else {
    await prepare([resolve(root, "scripts/prepare-development.mjs")]);
  }
  const preparedMs = performance.now() - started;
  const spawned = performance.now();
  child = run([require.resolve("next/dist/bin/next"), "dev", `--${bundler}`, "-H", "127.0.0.1", "-p", String(port)], {
    env: { ...process.env, PIORA_DEV_DIST_DIR: relative(root, resolve(directory, "next")).replaceAll("\\", "/"),
      PIORA_DEV_TSCONFIG: relative(root, resolve(directory, "tsconfig.json")).replaceAll("\\", "/"),
      PI_CODING_AGENT_DIR: resolve(directory, "agent") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Dev server readiness timed out")), 120_000);
    const read = (chunk) => {
      output += chunk;
      if (/Ready in\s+\d/.test(output)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Dev server exited ${code}: ${output.slice(-2000)}`)); });
  });
  const readyMs = performance.now() - spawned;
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requested = performance.now();
  const response = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 240_000 });
  if (!response?.ok()) throw new Error(`First page failed: HTTP ${response?.status()}`);
  const firstHtmlMs = performance.now() - requested;
  await page.locator(".app-shell").waitFor({ timeout: 120_000 });
  const result = { bundler, preparedMs, readyMs, firstHtmlMs, shellFromRequestMs: performance.now() - requested,
    totalMs: performance.now() - started, errors, directory };
  await page.screenshot({ path: resolve(directory, "first-shell.png") });
  await writeFile(resolve(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve) => killer.once("exit", resolve));
    } else { child.kill("SIGTERM"); }
  }
  await writeFile(resolve(directory, "server.log"), output);
}
