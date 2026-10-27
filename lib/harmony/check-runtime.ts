import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { configuredProduct, readHarmonyCheckConfig } from "./check-config";
import type {
  HarmonyCheckConfig,
  HarmonyCheckDiagnostic,
  HarmonyCheckEnvironment,
  HarmonyCheckKind,
  HarmonyCheckReport,
  HarmonyCheckSeverity,
  HarmonyCheckStep,
} from "./check-types";

// The desktop supervisor launches Next with the standalone web root as cwd;
// development and tests use the repository root. A direct runtime path avoids
// webpack rewriting createRequire/import.meta.url to an `(rsc)` pseudo-path.
const HARMONY_CHECK_RUNTIME_ROOT = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
const CLI_PACKAGE_PATH = join(HARMONY_CHECK_RUNTIME_ROOT, "node_modules", "@deveco", "deveco-cli", "package.json");
const CLI_PACKAGE = JSON.parse(readFileSync(CLI_PACKAGE_PATH, "utf8")) as { version?: string };
export const DEVECO_CLI_VERSION = CLI_PACKAGE.version ?? "1.3.9";
export const DEVECO_CLI_PATH = join(dirname(CLI_PACKAGE_PATH), "cli.js");
const MAX_DIAGNOSTICS = 500;
const IGNORE_DIRECTORIES = new Set([".git", ".hvigor", ".idea", ".preview", "build", "node_modules", "oh_modules"]);

type RunOptions = {
  projectRoot: string;
  checks?: HarmonyCheckKind[];
  files?: string[];
  fix?: boolean;
  product?: string;
  signal?: AbortSignal;
  config?: HarmonyCheckConfig;
};

function readStudioVersion(root: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, "product-info.json"), "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch { return undefined; }
}

function registryStudioCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  return roots.flatMap((root) => {
    const result = spawnSync("reg.exe", ["query", root, "/s", "/f", "DevEco Studio", "/k"], {
      encoding: "utf8", windowsHide: true, timeout: 4_000, maxBuffer: 512 * 1024,
    });
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("HKEY_"))
      .flatMap((key) => {
        const detail = spawnSync("reg.exe", ["query", key, "/v", "InstallLocation"], {
          encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024,
        });
        const match = String(detail.stdout).match(/InstallLocation\s+REG_\w+\s+(.+)$/m);
        return match?.[1]?.trim() ? [match[1].trim()] : [];
      });
  });
}

export function inspectHarmonyCheckEnvironment(config = readHarmonyCheckConfig()): HarmonyCheckEnvironment {
  const base = { platformSupported: process.platform === "win32", cliVersion: DEVECO_CLI_VERSION, cliPath: DEVECO_CLI_PATH };
  if (process.platform !== "win32") return { ...base, ready: false, error: "ArkTS checking currently supports Windows only" };
  if (!existsSync(DEVECO_CLI_PATH)) return { ...base, ready: false, error: "Bundled DevEco CLI is missing" };
  if (config.studioPath) {
    const studioPath = resolve(config.studioPath);
    const studioVersion = readStudioVersion(studioPath);
    return studioVersion
      ? { ...base, studioPath, studioVersion, source: "manual", ready: true }
      : { ...base, ready: false, error: `Configured DevEco Studio path is invalid: ${studioPath}` };
  }
  const candidates: Array<{ path: string; source: HarmonyCheckEnvironment["source"] }> = [
    ...(process.env.DEVECO_CLI_STUDIO_PATH ? [{ path: process.env.DEVECO_CLI_STUDIO_PATH, source: "environment" as const }] : []),
    ...registryStudioCandidates().map((path) => ({ path, source: "registry" as const })),
    { path: "C:\\Program Files\\Huawei\\DevEco Studio", source: "default" },
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const studioPath = resolve(candidate.path);
    const key = studioPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const studioVersion = readStudioVersion(studioPath);
    if (studioVersion) return { ...base, studioPath, studioVersion, source: candidate.source, ready: true };
  }
  return { ...base, ready: false, error: "DevEco Studio was not found. Install it or choose its installation folder in Settings > Harmony development." };
}

export function findHarmonyProjectRoot(start: string): string | null {
  let current = resolve(start);
  try { if (!statSync(current).isDirectory()) current = dirname(current); } catch { return null; }
  while (true) {
    if (existsSync(join(current, "build-profile.json5"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathInside(child: string, root: string): boolean {
  const value = relative(root, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export function collectArktsFiles(projectRoot: string, requested?: string[]): string[] {
  if (requested?.length) {
    const realRoot = realpathSync(projectRoot);
    const files = requested.map((file) => resolve(projectRoot, file));
    for (const file of files) {
      let realFile: string;
      try { realFile = realpathSync(file); } catch { throw new Error(`ArkTS file does not exist: ${file}`); }
      if (!pathInside(realFile, realRoot) || !file.toLowerCase().endsWith(".ets") || !statSync(realFile).isFile()) {
        throw new Error(`ArkTS file must be an existing .ets file inside the project: ${file}`);
      }
    }
    return [...new Set(files)].slice(0, 500);
  }
  const files: string[] = [];
  const visit = (directory: string) => {
    if (files.length >= 500) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORE_DIRECTORIES.has(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && item.name.toLowerCase().endsWith(".ets")) files.push(path);
      if (files.length >= 500) break;
    }
  };
  visit(projectRoot);
  return files;
}

export function sourceFingerprint(projectRoot: string): string {
  const hash = createHash("sha256");
  for (const file of collectArktsFiles(projectRoot).sort()) {
    hash.update(relative(projectRoot, file).replace(/\\/g, "/")).update("\0").update(readFileSync(file)).update("\n");
  }
  const visitConfig = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !IGNORE_DIRECTORIES.has(entry.name)) visitConfig(path);
      else if (entry.isFile() && (["build-profile.json5", "oh-package.json5", "oh-package-lock.json5", "code-linter.json5", "module.json5", "app.json5", "hvigorfile.ts"].includes(entry.name) || entry.name.endsWith(".d.ts"))) {
        hash.update(relative(projectRoot, path).replace(/\\/g, "/")).update("\0").update(readFileSync(path));
      }
    }
  };
  visitConfig(projectRoot);
  return hash.digest("hex");
}

function severity(value: unknown): HarmonyCheckSeverity {
  if (value === 1 || String(value).toLowerCase() === "error") return "error";
  if (value === 2 || String(value).toLowerCase() === "warning") return "warning";
  if (String(value).toLowerCase() === "suggestion") return "suggestion";
  return "info";
}

export function parseArktsDiagnostics(text: string, projectRoot: string): HarmonyCheckDiagnostic[] {
  const diagnostics: HarmonyCheckDiagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = " => Diagnostic: ";
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const rawFile = line.slice(0, index).trim();
    try {
      const values = JSON.parse(line.slice(index + marker.length)) as unknown[];
      for (const rawItem of values) {
        const serializedByDevEco = typeof rawItem === "string";
        let item: Record<string, unknown>;
        try {
          item = (serializedByDevEco ? JSON.parse(rawItem) : rawItem) as Record<string, unknown>;
        } catch { continue; }
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const range = item.range as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
        const file = isAbsolute(rawFile) ? resolve(rawFile) : resolve(projectRoot, rawFile);
        // DevEco CLI 1.3 serializes ArkTS diagnostics once inside the MCP
        // result and has already converted line numbers to one-based values.
        const lineBase = serializedByDevEco ? 0 : 1;
        diagnostics.push({
          source: "arkts", file, relativeFile: relative(projectRoot, file).replace(/\\/g, "/"),
          line: Math.max(1, (range?.start?.line ?? 0) + lineBase), column: (range?.start?.character ?? 0) + 1,
          endLine: Math.max(1, (range?.end?.line ?? range?.start?.line ?? 0) + lineBase),
          endColumn: (range?.end?.character ?? range?.start?.character ?? 0) + 1,
          severity: severity(item.severity),
          ...(item.code !== undefined ? { code: String(item.code) } : {}),
          message: typeof item.message === "string" ? item.message : "ArkTS diagnostic",
        });
      }
    } catch { /* A malformed line is retained in the step message by the caller. */ }
  }
  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

export function parseLintReport(value: unknown, projectRoot: string): { diagnostics: HarmonyCheckDiagnostic[]; filesChecked?: number } {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const issues = Array.isArray(source.issues) ? source.issues : [];
  const diagnostics = issues.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.file !== "string" || typeof item.message !== "string") return [];
    const file = isAbsolute(item.file) ? resolve(item.file) : resolve(projectRoot, item.file);
    return [{
      source: "lint" as const, file, relativeFile: relative(projectRoot, file).replace(/\\/g, "/"),
      line: Number.isFinite(item.line) ? Math.max(1, Number(item.line)) : 1,
      column: Number.isFinite(item.column) ? Math.max(1, Number(item.column)) : 1,
      severity: severity(item.severity),
      ...(typeof item.rule === "string" ? { rule: item.rule } : {}), message: item.message,
    }];
  }).slice(0, MAX_DIAGNOSTICS);
  const summary = source.summary && typeof source.summary === "object" ? source.summary as Record<string, unknown> : {};
  return { diagnostics, ...(Number.isFinite(summary.filesChecked) ? { filesChecked: Number(summary.filesChecked) } : {}) };
}

function abortError(): Error { return Object.assign(new Error("Harmony check cancelled"), { name: "AbortError" }); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

class ArktsRuntime {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly projectRoot: string, private readonly environment: HarmonyCheckEnvironment, private readonly config: HarmonyCheckConfig) {}
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, 10 * 60_000);
    this.idleTimer.unref?.();
  }
  async connect(signal?: AbortSignal) {
    if (this.client) { this.touch(); return; }
    if (this.connecting) return this.connecting;
    this.connecting = this.open(signal).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(signal?: AbortSignal) {
    if (!this.environment.studioPath) throw new Error(this.environment.error ?? "DevEco Studio is unavailable");
    const client = new Client({ name: "piora-harmony-check", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [DEVECO_CLI_PATH, "serve", "mcp"], cwd: this.projectRoot,
      env: {
        PROJECT_PATH: this.projectRoot,
        DEVECO_CLI_STUDIO_PATH: this.environment.studioPath,
        DEVECO_CLI_DISABLE_TELEMETRY: "1", DEVECO_CLI_DISABLE_UPDATE: "1", DEVECO_CLI_CPP_ENABLED: "0",
      }, stderr: "pipe", maxBufferSize: 8 * 1024 * 1024,
    });
    transport.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4_000); });
    this.transport = transport;
    try {
      await client.connect(transport, { timeout: Math.min(20_000, this.config.timeoutMs), ...(signal ? { signal } : {}) });
      const tools = await client.listTools({}, { timeout: 10_000, ...(signal ? { signal } : {}) });
      if (!tools.tools.some((tool) => tool.name === "check")) throw new Error("DevEco CLI did not expose the ArkTS check tool");
      this.client = client;
      client.onclose = () => { if (this.client === client) this.client = undefined; };
      this.touch();
    } catch (error) {
      await transport.close().catch(() => {});
      if (this.transport === transport) this.transport = undefined;
      throw new Error(`${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr}` : ""}`);
    }
  }
  async check(files: string[], signal?: AbortSignal): Promise<string> {
    try {
      await this.connect(signal);
      const deadline = Date.now() + this.config.timeoutMs;
      for (;;) {
        signal?.throwIfAborted();
        const remaining = Math.max(1_000, deadline - Date.now());
        if (remaining <= 1_000) throw new Error("ArkTS language service did not become ready before the timeout");
        const result = await this.client!.callTool({ name: "check", arguments: { files } }, undefined, {
          timeout: Math.min(20_000, remaining), ...(signal ? { signal } : {}),
        });
        const text = Array.isArray(result.content) ? result.content.flatMap((block) =>
          block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
        ).join("\n") : "";
        if (!/retry in \d+ seconds|is initializing|is syncing/i.test(text)) {
          if (result.isError) throw new Error(text || "ArkTS check failed");
          this.touch();
          return text;
        }
        await delay(Math.min(3_000, Math.max(500, deadline - Date.now())), signal);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const transport = this.transport;
    this.client = undefined; this.transport = undefined;
    await transport?.close().catch(() => {});
  }
}

declare global { var __pioraArktsRuntimes: Map<string, ArktsRuntime> | undefined; }
function arktsRuntime(projectRoot: string, environment: HarmonyCheckEnvironment, config: HarmonyCheckConfig): ArktsRuntime {
  const key = `${resolve(projectRoot).toLowerCase()}\0${environment.studioPath ?? ""}`;
  const runtimes = globalThis.__pioraArktsRuntimes ??= new Map();
  let runtime = runtimes.get(key);
  if (!runtime) { runtime = new ArktsRuntime(projectRoot, environment, config); runtimes.set(key, runtime); }
  return runtime;
}

export async function closeHarmonyCheckRuntimes(): Promise<void> {
  const runtimes = globalThis.__pioraArktsRuntimes;
  globalThis.__pioraArktsRuntimes = new Map();
  if (runtimes) await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
}

async function runArkts(projectRoot: string, files: string[], environment: HarmonyCheckEnvironment, config: HarmonyCheckConfig, signal?: AbortSignal): Promise<HarmonyCheckStep> {
  const started = Date.now();
  try {
    if (!files.length) return { kind: "arkts", status: "passed", durationMs: Date.now() - started, diagnostics: [], filesChecked: 0 };
    const text = await arktsRuntime(projectRoot, environment, config).check(files, signal);
    const diagnostics = parseArktsDiagnostics(text, projectRoot);
    const hasUnparsedPayload = diagnostics.some((item) => item.message === "ArkTS diagnostic");
    return { kind: "arkts", status: diagnostics.length ? "issues" : "passed", durationMs: Date.now() - started, diagnostics, filesChecked: files.length,
      ...((hasUnparsedPayload || (!diagnostics.length && !/no diagnostics/i.test(text) && text.trim())) ? { message: text.slice(0, 4_000) } : {}) };
  } catch (error) {
    const cancelled = signal?.aborted || (error instanceof Error && error.name === "AbortError");
    return { kind: "arkts", status: cancelled ? "cancelled" : "incomplete", durationMs: Date.now() - started, diagnostics: [], message: error instanceof Error ? error.message : String(error) };
  }
}

function spawnCaptured(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-256 * 1024);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const stop = () => { if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolveRun({ code, stdout, stderr, timedOut }); });
  });
}

const TEMP_LINTER_CONFIG = `{
  files: ["**/*.ets"],
  ignore: ["**/node_modules/**", "**/oh_modules/**", "**/build/**", "**/.preview/**", "**/test/**", "**/tests/**"],
  ruleSet: ["plugin:@performance/recommended", "plugin:@typescript-eslint/recommended"],
  rules: {}
}\n`;

async function runLint(projectRoot: string, environment: HarmonyCheckEnvironment, config: HarmonyCheckConfig, options: { fix?: boolean; product?: string; signal?: AbortSignal }): Promise<HarmonyCheckStep> {
  const started = Date.now();
  const id = randomUUID().replace(/-/g, "");
  const outputPath = join(tmpdir(), `piora-lint-${id}.json`);
  const projectConfig = join(projectRoot, "code-linter.json5");
  const temporaryConfig = join(projectRoot, `.piora-code-linter-${id}.json5`);
  try {
    if (!existsSync(projectConfig)) writeFileSync(temporaryConfig, TEMP_LINTER_CONFIG, { encoding: "utf8", flag: "wx" });
    const args = [DEVECO_CLI_PATH, "check", "lint", projectRoot, "--format", "json", "--output-path", outputPath, "--limit", String(MAX_DIAGNOSTICS),
      "--config-path", existsSync(projectConfig) ? projectConfig : temporaryConfig];
    if (options.product) args.push("--product", options.product);
    if (options.fix) args.push("--fix");
    const result = await spawnCaptured(process.execPath, args, projectRoot, {
      ...process.env, DEVECO_CLI_STUDIO_PATH: environment.studioPath,
      DEVECO_CLI_DISABLE_TELEMETRY: "1", DEVECO_CLI_DISABLE_UPDATE: "1", DEVECO_CLI_CPP_ENABLED: "0",
    }, config.timeoutMs, options.signal);
    if (options.signal?.aborted) throw abortError();
    if (result.timedOut) throw new Error(`Code Linter exceeded ${Math.round(config.timeoutMs / 1000)} seconds`);
    if (!existsSync(outputPath)) throw new Error((result.stderr || result.stdout || `Code Linter exited with code ${result.code}`).trim());
    const parsed = parseLintReport(JSON.parse(readFileSync(outputPath, "utf8")), projectRoot);
    return { kind: "lint", status: parsed.diagnostics.length ? "issues" : "passed", durationMs: Date.now() - started, diagnostics: parsed.diagnostics,
      ...(parsed.filesChecked !== undefined ? { filesChecked: parsed.filesChecked } : {}) };
  } catch (error) {
    const cancelled = options.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    return { kind: "lint", status: cancelled ? "cancelled" : "incomplete", durationMs: Date.now() - started, diagnostics: [], message: error instanceof Error ? error.message : String(error) };
  } finally {
    try { rmSync(outputPath, { force: true }); } catch {}
    try { rmSync(temporaryConfig, { force: true }); } catch {}
  }
}

function reportPath(projectRoot: string, root = getAgentDir()): string {
  const key = createHash("sha256").update(resolve(projectRoot).toLowerCase()).digest("hex");
  return join(root, "piora", "harmony-check", "reports", `${key}.json`);
}

export function readHarmonyCheckReport(projectRoot: string, root = getAgentDir()): (HarmonyCheckReport & { stale: boolean }) | null {
  try {
    const resolvedRoot = findHarmonyProjectRoot(projectRoot) ?? resolve(projectRoot);
    const report = JSON.parse(readFileSync(reportPath(resolvedRoot, root), "utf8")) as HarmonyCheckReport;
    if (report.schemaVersion !== 1 || resolve(report.projectRoot).toLowerCase() !== resolvedRoot.toLowerCase()) return null;
    return { ...report, stale: report.sourceFingerprint !== sourceFingerprint(resolvedRoot) };
  } catch { return null; }
}

function persistReport(report: HarmonyCheckReport, root = getAgentDir()) {
  const path = reportPath(report.projectRoot, root);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runHarmonyCheck(options: RunOptions): Promise<HarmonyCheckReport> {
  const projectRoot = findHarmonyProjectRoot(options.projectRoot);
  if (!projectRoot) throw new Error("No Harmony project-level build-profile.json5 was found");
  const config = options.config ?? readHarmonyCheckConfig();
  const environment = inspectHarmonyCheckEnvironment(config);
  const requested = options.checks?.length ? [...new Set(options.checks)] : [
    ...(config.arktsEnabled ? ["arkts" as const] : []), ...(config.lintEnabled ? ["lint" as const] : []),
  ];
  if (!requested.length) throw new Error("Enable at least one Harmony check");
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const files = collectArktsFiles(projectRoot, options.files);
  let checks: HarmonyCheckStep[];
  if (!environment.ready) {
    checks = requested.map((kind) => ({ kind, status: "incomplete", durationMs: 0, diagnostics: [], message: environment.error }));
  } else {
    const product = options.product ?? configuredProduct(config, projectRoot);
    checks = await Promise.all(requested.map((kind) => kind === "arkts"
      ? runArkts(projectRoot, files, environment, config, options.signal)
      : runLint(projectRoot, environment, config, { fix: options.fix, product, signal: options.signal })));
  }
  const diagnostics = checks.flatMap((step) => step.diagnostics).sort((a, b) => a.relativeFile.localeCompare(b.relativeFile) || a.line - b.line || a.column - b.column);
  const summary = {
    errors: diagnostics.filter((item) => item.severity === "error").length,
    warnings: diagnostics.filter((item) => item.severity === "warning").length,
    suggestions: diagnostics.filter((item) => item.severity === "suggestion").length,
    info: diagnostics.filter((item) => item.severity === "info").length,
    total: diagnostics.length,
  };
  const status = checks.some((step) => step.status === "cancelled") ? "cancelled"
    : checks.some((step) => step.status === "incomplete") ? "incomplete"
      : diagnostics.length ? "issues" : "passed";
  const completed = Date.now();
  const report: HarmonyCheckReport = {
    schemaVersion: 1, id: `hc_${randomUUID().replace(/-/g, "").slice(0, 20)}`, projectRoot,
    ...(options.product ?? configuredProduct(config, projectRoot) ? { product: options.product ?? configuredProduct(config, projectRoot) } : {}),
    status, startedAt, completedAt: new Date(completed).toISOString(), durationMs: completed - started,
    sourceFingerprint: sourceFingerprint(projectRoot), checks, diagnostics, summary, toolchain: environment,
  };
  persistReport(report);
  return report;
}

export function harmonyCheckDisplayName(projectRoot: string): string {
  return basename(findHarmonyProjectRoot(projectRoot) ?? projectRoot);
}
