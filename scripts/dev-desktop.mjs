import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDesktopDevRelay } from "./desktop-dev-relay.mjs";
import { desktopDevelopmentEnvironment } from "./desktop-dev-environment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const requestedPort = process.env.PIORA_DESKTOP_DEV_PORT?.trim();
const port = requestedPort ? Number(requestedPort) : 30141;
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("PIORA_DESKTOP_DEV_PORT must be an integer between 1024 and 65535");
}
const debugPort = process.env.PIORA_DESKTOP_DEV_DEBUG_PORT?.trim();
if (debugPort && (!Number.isInteger(Number(debugPort)) || Number(debugPort) < 1024 || Number(debugPort) > 65535)) {
  throw new Error("PIORA_DESKTOP_DEV_DEBUG_PORT must be an integer between 1024 and 65535");
}
const applicationUrl = new URL(`http://${host}:${port}/`);
const token = randomBytes(32).toString("base64url");
const developmentEnvironment = desktopDevelopmentEnvironment(root);
const devUserData = developmentEnvironment.PIORA_DESKTOP_DEV_USER_DATA;
const runtimeData = developmentEnvironment.PIORA_DESKTOP_DATA_DIR;
const require = createRequire(import.meta.url);

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: npm run dev:desktop\nStarts authenticated Next.js dev, the Electron TypeScript watcher, and Electron.\n");
  process.exit(0);
}

mkdirSync(runtimeData, { recursive: true });

const sharedEnvironment = {
  ...process.env,
  ...developmentEnvironment,
  PI_DESKTOP_TOKEN: token,
};

let nextProcess;
let typeScriptProcess;
let electronProcess;
const desktopRelay = createDesktopDevRelay((message) => {
  if (nextProcess?.connected) nextProcess.send(message, () => {});
});
let stopping = false;
let expectedElectronExit = false;
let initialCompileResolved = false;
let resolveInitialCompile;
let rejectInitialCompile;
const initialCompile = new Promise((resolve, reject) => {
  resolveInitialCompile = resolve;
  rejectInitialCompile = reject;
});
let resolveNextReady;
let rejectNextReady;
const nextReady = new Promise((resolve, reject) => {
  resolveNextReady = resolve;
  rejectNextReady = reject;
});

function log(scope, message) {
  process.stdout.write(`[dev:desktop:${scope}] ${message}\n`);
}

function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function waitForExit(child) {
  if (!isRunning(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function terminateTree(child) {
  if (!isRunning(child) || !child.pid) return;
  const exit = waitForExit(child);
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([new Promise((resolve) => killer.once("exit", resolve)), exit]);
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (isRunning(child)) {
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        await new Promise((resolve) => killer.once("exit", resolve));
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch { /* The process may have exited between checks. */ }
  }
}

function forwardLines(stream, scope, onLine) {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001bc/g, "").trimEnd();
      if (line) log(scope, line);
      onLine?.(line);
    }
  });
}

async function ensurePortAvailable() {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(`Cannot start: ${applicationUrl.origin} is already in use (${error.message})`)));
    server.listen({ host, port, exclusive: true }, () => server.close(resolve));
  });
}

function electronExecutable() {
  return require("electron");
}

function launchElectron() {
  if (stopping || electronProcess) return;
  log("electron", "starting desktop shell");
  expectedElectronExit = false;
  electronProcess = spawn(electronExecutable(), [join(root, "desktop"),
    ...(debugPort ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debugPort}`] : []),
  ], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...sharedEnvironment,
      PI_DESKTOP_DEV_SERVER_URL: applicationUrl.toString(),
      PIORA_DESKTOP_DEV_USER_DATA: devUserData,
      PI_DESKTOP_DEVTOOLS: "1",
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: false,
  });
  desktopRelay.attach(electronProcess);
  electronProcess.once("exit", (code, signal) => {
    electronProcess = undefined;
    if (stopping) return;
    if (expectedElectronExit) {
      expectedElectronExit = false;
      launchElectron();
      return;
    }
    log("electron", `exited (code=${String(code)}, signal=${String(signal)})`);
    void shutdown(code ?? 0);
  });
}

async function restartElectron() {
  if (stopping || !electronProcess) return;
  log("electron", "desktop source changed; restarting shell");
  expectedElectronExit = true;
  const previous = electronProcess;
  await terminateTree(previous);
  if (electronProcess === previous) electronProcess = undefined;
  if (expectedElectronExit && !stopping) {
    expectedElectronExit = false;
    launchElectron();
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  log("cleanup", "stopping Electron, TypeScript, and Next.js");
  await Promise.all([
    terminateTree(electronProcess),
    terminateTree(typeScriptProcess),
    terminateTree(nextProcess),
  ]);
  process.exitCode = exitCode;
}

async function main() {
  log("profile", `Piora Dev user data: ${devUserData}`);
  log("profile", `Pi agent data: ${developmentEnvironment.PI_CODING_AGENT_DIR}`);
  await ensurePortAvailable();
  log("next", `starting authenticated development server at ${applicationUrl.origin}`);
  // Turbopack owns dev compilation and CSS HMR; next.config.ts adapts the
  // shared desktop sources without changing the packaged CommonJS build.
  nextProcess = spawn(process.execPath, [join(root, "scripts", "desktop-next-dev.cjs"), "dev", "--turbopack", "-H", host, "-p", String(port)], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...sharedEnvironment, PIORA_DESKTOP_NETWORK_IPC: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  nextProcess.on("message", (message) => desktopRelay.receive(message));
  const handleNextLine = (line) => {
    if (/(?:^|\s)(?:✓\s*)?Ready in\s+\d/i.test(line)) resolveNextReady();
  };
  forwardLines(nextProcess.stdout, "next", handleNextLine);
  forwardLines(nextProcess.stderr, "next", handleNextLine);
  nextProcess.once("exit", (code, signal) => {
    if (!stopping) {
      rejectNextReady(new Error("Next.js development server exited before it became ready"));
      log("next", `exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
      void shutdown(code || 1);
    }
  });

  log("tsc", "watching desktop/src");
  typeScriptProcess = spawn(process.execPath, [join(root, "node_modules", "@typescript", "native", "lib", "tsc.js"), "-p", join(root, "desktop", "tsconfig.json"), "--watch", "--preserveWatchOutput"], {
    cwd: root,
    detached: process.platform !== "win32",
    env: sharedEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handleTypeScriptLine = (line) => {
    if (!/Found 0 errors?\./i.test(line)) return;
    if (!initialCompileResolved) {
      initialCompileResolved = true;
      resolveInitialCompile();
      return;
    }
    void restartElectron();
  };
  forwardLines(typeScriptProcess.stdout, "tsc", handleTypeScriptLine);
  forwardLines(typeScriptProcess.stderr, "tsc", handleTypeScriptLine);
  typeScriptProcess.once("exit", (code, signal) => {
    if (!initialCompileResolved) rejectInitialCompile(new Error(`Electron TypeScript watcher exited before a successful compile (code=${String(code)}, signal=${String(signal)})`));
    if (!stopping) void shutdown(code || 1);
  });

  const nextReadyWithTimeout = Promise.race([
    nextReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Next.js did not report readiness within 60 seconds")), 60_000)),
  ]);
  await Promise.all([nextReadyWithTimeout, initialCompile]);
  if (stopping) return;
  launchElectron();
  log("ready", "React/CSS hot reload is active; desktop source changes restart Electron");
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));

main().catch(async (error) => {
  process.stderr.write(`[dev:desktop] ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
});
