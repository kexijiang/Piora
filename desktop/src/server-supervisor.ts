import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import type { Logger } from "./logger.js";
import type { RuntimeProfile } from "./desktop-state.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_START_ATTEMPTS = 5;
const START_RETRY_BASE_DELAY_MS = 750;
const MAX_LOG_LINE_LENGTH = 16_384;

export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StandaloneServerOptions {
  serverEntry: string;
  serverHostEntry: string;
  /** Absolute root containing Piora's staged `extensions/` directory. */
  runtimeRoot: string;
  nodePath?: string;
  homeDirectory: string;
  agentDirectory: string;
  speechPacksDirectory?: string;
  harmonyToolsDirectory?: string;
  winAppPath?: string;
  token: string;
  logger: Logger;
  preferredPort?: number;
  startupTimeoutMs?: number;
  runtimeProfile?: RuntimeProfile;
  desktopDataDirectory?: string;
  onMessage?: (message: unknown) => unknown | Promise<unknown>;
  onUnexpectedExit?: (exit: ServerExit) => void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function reservePort(preferredPort?: number): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createServer();
    socket.unref();
    socket.once("error", rejectPort);
    socket.listen(
      { host: LOOPBACK_HOST, port: preferredPort ?? 0, exclusive: true },
      () => {
        const address = socket.address();
        if (!address || typeof address === "string") {
          socket.close();
          rejectPort(new Error("Unable to determine the allocated server port"));
          return;
        }

        const allocatedPort = address.port;
        socket.close((error) => {
          if (error) rejectPort(error);
          else resolvePort(allocatedPort);
        });
      },
    );
  });
}

function probeServer(url: URL, token: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = request(
      url,
      {
        method: "GET",
        agent: false,
        headers: {
          Accept: "text/html",
          Connection: "close",
          "X-Pi-Desktop-Token": token,
        },
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 500;
        resolveProbe(status >= 200 && status < 400);
      },
    );

    probe.setTimeout(1_000, () => probe.destroy());
    probe.once("error", () => resolveProbe(false));
    probe.end();
  });
}

async function waitUntilHealthy(
  url: URL,
  token: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!signal.aborted && Date.now() < deadline) {
    if (await probeServer(url, token)) return;
    await delay(175);
  }

  if (signal.aborted) throw new Error("Server health check was cancelled");
  throw new Error(`Server did not become healthy within ${timeoutMs} ms`);
}

function attachLineLogger(
  stream: Readable | null,
  logger: Logger,
  level: "info" | "warn",
  onLine?: (line: string) => void,
): void {
  if (!stream) return;

  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      onLine?.(line);
      logger[level]("[web] " + line.slice(0, MAX_LOG_LINE_LENGTH));
    }
  });
  stream.on("end", () => {
    if (pending) {
      onLine?.(pending);
      logger[level]("[web] " + pending.slice(0, MAX_LOG_LINE_LENGTH));
    }
  });
}

export function isNextServerReadyLine(line: string): boolean {
  return /(?:^|\s)(?:✓\s*)?Ready in\s+\d/i.test(line.trim());
}

function waitForExit(child: ChildProcess): Promise<ServerExit> {
  if (!isRunning(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopChild(child: ChildProcess, logger: Logger, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return;

  const exitPromise = waitForExit(child);
  try {
    if (child.connected) {
      child.send({ type: "pi-desktop:shutdown" } satisfies ShutdownMessage);
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    logger.warn("Unable to request graceful web server shutdown", error);
  }

  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);

  if (exitedGracefully || !isRunning(child)) return;

  logger.warn("Web server did not stop in time; terminating it");
  child.kill("SIGKILL");
  await Promise.race([exitPromise, delay(1_000)]);
}

interface ShutdownMessage {
  type: "pi-desktop:shutdown";
}

export class StandaloneServer {
  private readonly options: StandaloneServerOptions;
  private child: ChildProcess | undefined;
  private ready = false;
  private stopping = false;
  private serverUrl: URL | undefined;

  constructor(options: StandaloneServerOptions) {
    this.options = options;
  }

  get url(): URL | undefined {
    return this.serverUrl;
  }

  async start(): Promise<URL> {
    if (this.child) throw new Error("The standalone server has already been started");
    this.stopping = false;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      let port: number;
      try {
        port = await reservePort(attempt === 1 ? this.options.preferredPort : undefined);
      } catch (error) {
        lastError = error;
        this.options.logger.warn("Unable to reserve the preferred server port", error);
        continue;
      }

      const url = new URL(`http://${LOOPBACK_HOST}:${port}/`);
      let resolveRuntimeReady!: () => void;
      const runtimeReady = new Promise<void>((resolveReady) => {
        resolveRuntimeReady = resolveReady;
      });
      const child = this.spawnServer(port, resolveRuntimeReady);
      this.child = child;
      const healthAbort = new AbortController();

      const earlyExit = new Promise<never>((_resolve, reject) => {
        child.once("error", (error) => reject(error));
        child.once("exit", (code, signal) => {
          reject(new Error(`Web server exited during startup (code=${String(code)}, signal=${String(signal)})`));
        });
      });

      try {
        const readinessSource = await Promise.race([
          waitUntilHealthy(
            new URL("/api/health", url),
            this.options.token,
            this.options.startupTimeoutMs ?? 30_000,
            healthAbort.signal,
          ).then(() => "health" as const),
          runtimeReady.then(() => "next-ready" as const),
          earlyExit,
        ]);
        healthAbort.abort();
        this.ready = true;
        this.serverUrl = url;
        this.options.logger.info("Web server is ready", {
          origin: url.origin,
          pid: child.pid,
          readinessSource,
        });
        return url;
      } catch (error) {
        healthAbort.abort();
        lastError = error;
        this.options.logger.warn(`Web server start attempt ${attempt} failed`, error);
        await stopChild(child, this.options.logger, 1_000);
        if (this.child === child) this.child = undefined;
        if (attempt < MAX_START_ATTEMPTS) {
          // Portable builds can be scanned immediately after extraction. A
          // short increasing delay gives Defender and third-party scanners
          // time to release transient locks before the next attempt.
          await delay(START_RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    const lastMessage = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(`Unable to start the Piora server. Last error: ${lastMessage}`, { cause: lastError });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.serverUrl = undefined;

    const child = this.child;
    this.child = undefined;
    if (!child) return;

    this.options.logger.info("Stopping web server", { pid: child.pid });
    await stopChild(child, this.options.logger, 6_000);
  }

  private spawnServer(port: number, onRuntimeReady: () => void): ChildProcess {
    const child = spawn(
      process.execPath,
      [this.options.serverHostEntry, this.options.serverEntry],
      {
        cwd: dirname(this.options.serverEntry),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          HOSTNAME: LOOPBACK_HOST,
          PORT: String(port),
          NODE_ENV: "production",
          ...(this.options.nodePath ? { NODE_PATH: this.options.nodePath } : {}),
          NEXT_TELEMETRY_DISABLED: "1",
          PI_WEB_HOSTNAME: LOOPBACK_HOST,
          PI_WEB_ALLOWED_HOSTS: LOOPBACK_HOST,
          PI_WEB_NO_OPEN: "1",
          PIORA_HOME: this.options.homeDirectory,
          PIORA_WEB_RUNTIME_ROOT: this.options.runtimeRoot,
          PIORA_RUNTIME_PROFILE: this.options.runtimeProfile ?? "normal",
          PIORA_DESKTOP_NETWORK_IPC: "1",
          ...(this.options.desktopDataDirectory
            ? { PIORA_DESKTOP_DATA_DIR: this.options.desktopDataDirectory }
            : {}),
          PI_CODING_AGENT_DIR: this.options.agentDirectory,
          ...(this.options.speechPacksDirectory
            ? { PIORA_SPEECH_PACKS_DIR: this.options.speechPacksDirectory }
            : {}),
          ...(this.options.harmonyToolsDirectory
            ? { PIORA_HARMONY_TOOLS_DIR: this.options.harmonyToolsDirectory }
            : {}),
          ...(this.options.winAppPath ? { PIORA_WINAPP_PATH: this.options.winAppPath } : {}),
          // Desktop requests use the per-launch token below. Do not inherit an
          // unrelated shell-wide Basic Auth password that the renderer and
          // health probe cannot satisfy.
          PI_WEB_PASSWORD: "",
          PI_DESKTOP_TOKEN: this.options.token,
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );

    let runtimeReady = false;
    attachLineLogger(child.stdout, this.options.logger, "info", (line) => {
      if (runtimeReady || !isNextServerReadyLine(line)) return;
      runtimeReady = true;
      onRuntimeReady();
    });
    attachLineLogger(child.stderr, this.options.logger, "warn");
    child.on("message", (message: unknown) => {
      if (!this.options.onMessage) return;
      void Promise.resolve(this.options.onMessage(message)).then((response) => {
        if (
          response === undefined
          || response === null
          || !["string", "number", "boolean", "bigint", "object"].includes(typeof response)
          || !child.connected
          || !isRunning(child)
        ) return;
        child.send(response as string | number | boolean | bigint | object);
      }).catch((error) => {
        this.options.logger.warn("Unable to handle a web server IPC message", error);
      });
    });
    this.options.logger.info("Starting web server", {
      entry: this.options.serverEntry,
      pid: child.pid,
      port,
    });

    child.once("exit", (code, signal) => {
      this.options.logger.info("Web server exited", { code, signal });
      if (this.child === child) this.child = undefined;
      if (this.ready && !this.stopping) {
        this.ready = false;
        this.serverUrl = undefined;
        this.options.onUnexpectedExit?.({ code, signal });
      }
    });

    return child;
  }
}
