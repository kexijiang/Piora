import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { analyzeHarmonyProject } from "./project-analyzer";
import { getDesignPreviewWorkspace, type DesignPreviewWorkspace } from "./preview-workspace";
import type {
  DesignAnalysisRun,
  DesignBuildDiagnostic,
  DesignBuildResult,
  GeneratedArtifactManifest,
  HarmonyBuildProfile,
} from "./types";
import { resolveHdcPath } from "../harmony/runtime";

const MAX_COPY_FILES = 60_000;
const MAX_COPY_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 160 * 1024;
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const SKIP_DIRECTORIES = new Set([".git", ".idea", ".hvigor", ".preview", ".real", ".cxx"]);
const ROOT_FILES = new Set([
  "build-profile.json5", "hvigorfile.ts", "oh-package.json5", "oh-package-lock.json5",
  "local.properties", "hvigorw", "hvigorw.bat",
]);

export interface HarmonyBuildSelection {
  module?: string;
  target?: string;
  product?: string;
  buildMode?: "debug" | "release";
}

export interface HarmonyBuildRuntimeOverride {
  nodePath: string;
  sdkPath: string;
  wrapperPath: string;
}

function properties(path: string): Map<string, string> {
  try {
    return new Map(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
      const match = /^\s*([^#!][^=]*)=(.*)$/.exec(line);
      return match ? [[match[1].trim(), match[2].trim().replace(/\\:/g, ":")]] : [];
    }));
  } catch { return new Map(); }
}

function file(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function directory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function sdkDirectory(path: string): boolean {
  return directory(path) && (
    file(join(path, "default", "sdk-pkg.json"))
    || directory(join(path, "default", "openharmony", "ets"))
    || directory(join(path, "openharmony", "ets"))
    || directory(join(path, "ets"))
  );
}

function devecoHomeFromHdc(hdcPath: string): string | undefined {
  let cursor = dirname(hdcPath);
  for (let index = 0; index < 8; index += 1) {
    if (basename(cursor).toLowerCase() === "sdk") return dirname(cursor);
    cursor = dirname(cursor);
  }
  return undefined;
}

function resolveBuildRuntime(projectRoot: string, override?: HarmonyBuildRuntimeOverride): HarmonyBuildRuntimeOverride {
  if (override) {
    if (![override.nodePath, override.wrapperPath].every(file) || !directory(override.sdkPath)) {
      throw new DesignToHarmonyError("BUILD_TOOL_NOT_FOUND", "The configured Harmony build runtime is incomplete", { status: 409, stage: "build" });
    }
    return { nodePath: resolve(override.nodePath), sdkPath: resolve(override.sdkPath), wrapperPath: resolve(override.wrapperPath) };
  }
  const local = properties(join(projectRoot, "local.properties"));
  let devecoHome: string | undefined;
  try { devecoHome = devecoHomeFromHdc(resolveHdcPath().hdcPath); } catch { /* build remains available through explicit project paths */ }
  const nodeCandidates = [
    process.env.PIORA_DEVECO_NODE_PATH,
    local.get("nodejs.dir") ? join(local.get("nodejs.dir")!, process.platform === "win32" ? "node.exe" : "bin/node") : undefined,
    devecoHome ? join(devecoHome, "tools", "node", process.platform === "win32" ? "node.exe" : "bin/node") : undefined,
    process.execPath,
  ].filter((value): value is string => Boolean(value));
  const sdkCandidates = [
    process.env.PIORA_DEVECO_SDK_PATH,
    local.get("hwsdk.dir"),
    devecoHome ? join(devecoHome, "sdk") : undefined,
  ].filter((value): value is string => Boolean(value));
  const wrapperCandidates = [
    join(projectRoot, "hvigor", "hvigor-wrapper.js"),
    process.env.PIORA_HVIGOR_WRAPPER_PATH,
    devecoHome ? join(devecoHome, "tools", "hvigor", "bin", "hvigorw.js") : undefined,
  ].filter((value): value is string => Boolean(value));
  const nodePath = nodeCandidates.find(file);
  const sdkPath = sdkCandidates.find(sdkDirectory);
  const wrapperPath = wrapperCandidates.find(file);
  if (!nodePath || !sdkPath || !wrapperPath) {
    throw new DesignToHarmonyError("BUILD_TOOL_NOT_FOUND", "DevEco Studio Node.js, SDK, or Hvigor wrapper could not be found", {
      status: 409,
      retryable: true,
      stage: "build",
      details: { nodeFound: Boolean(nodePath), sdkFound: Boolean(sdkPath), wrapperFound: Boolean(wrapperPath) },
    });
  }
  return { nodePath: resolve(nodePath), sdkPath: resolve(sdkPath), wrapperPath: resolve(wrapperPath) };
}

export function detectHarmonyBuildProfile(
  projectRootValue: string,
  selection: HarmonyBuildSelection = {},
  runtime?: HarmonyBuildRuntimeOverride,
): HarmonyBuildProfile {
  const projectRoot = resolve(projectRootValue);
  const inventory = analyzeHarmonyProject(projectRoot);
  const moduleName = selection.module ?? inventory.selectedModule;
  const moduleConfig = inventory.modules.find((candidate) => candidate.name === moduleName);
  if (!moduleName || !moduleConfig) throw new DesignToHarmonyError("UNSUPPORTED_PROJECT", "Select a valid Harmony module before building", { status: 409, stage: "build" });
  const target = selection.target ?? moduleConfig.targets[0] ?? "default";
  if (!moduleConfig.targets.includes(target)) throw new DesignToHarmonyError("INVALID_ARGUMENT", "The selected Harmony module target does not exist", { status: 400, stage: "build" });
  const product = selection.product ?? inventory.selectedProduct ?? "default";
  if (!inventory.products.includes(product)) throw new DesignToHarmonyError("INVALID_ARGUMENT", "The selected Harmony product does not exist", { status: 400, stage: "build" });
  const detected = resolveBuildRuntime(projectRoot, runtime);
  return {
    projectRoot,
    module: moduleName,
    target,
    product,
    buildMode: selection.buildMode ?? "debug",
    ...(inventory.compileSdkVersion ? { compileSdkVersion: inventory.compileSdkVersion } : {}),
    ...(inventory.compatibleSdkVersion ? { compatibleSdkVersion: inventory.compatibleSdkVersion } : {}),
    sdkPath: detected.sdkPath,
    nodePath: detected.nodePath,
    wrapperPath: detected.wrapperPath,
  };
}

function copyEntry(source: string, destination: string, budget: { files: number; bytes: number }, insideDependencies = false): void {
  const details = lstatSync(source);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    const name = basename(source);
    if (SKIP_DIRECTORIES.has(name) || (name === "build" && !insideDependencies)) return;
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      copyEntry(join(source, entry.name), join(destination, entry.name), budget, insideDependencies || name === "oh_modules");
    }
    return;
  }
  if (!details.isFile()) return;
  budget.files += 1;
  budget.bytes += details.size;
  if (budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES) {
    throw new DesignToHarmonyError("BUILD_SNAPSHOT_TOO_LARGE", "Harmony project snapshot exceeds the safe build limit", { status: 413, stage: "build" });
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE);
}

function createBuildSnapshot(input: {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  profile: HarmonyBuildProfile;
  workspace: DesignPreviewWorkspace;
  root: string;
  mode: "preview" | "applied";
}): string {
  const sourceRoot = input.run.projectRoot;
  const shadowRoot = join(input.root, "project");
  mkdirSync(shadowRoot, { recursive: true, mode: 0o700 });
  const inventory = analyzeHarmonyProject(sourceRoot);
  const moduleConfig = inventory.modules.find((item) => item.name === input.profile.module)!;
  const roots = ["hvigor", "AppScope", "oh_modules", moduleConfig.relativePath]
    .map((item) => join(sourceRoot, item)).filter(existsSync);
  const budget = { files: 0, bytes: 0 };
  for (const root of roots) copyEntry(root, join(shadowRoot, relative(sourceRoot, root)), budget);
  for (const name of ROOT_FILES) {
    const source = join(sourceRoot, name);
    if (file(source)) copyEntry(source, join(shadowRoot, name), budget);
  }
  if (input.mode === "preview") {
    for (const artifact of input.preview.artifacts) {
      const output = join(shadowRoot, ...artifact.relativePath.split("/"));
      const data = input.workspace.readBytes(input.run.id, input.preview.id, artifact.relativePath).data;
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, data, { mode: 0o600 });
    }
  }
  const local = [
    "# Generated inside an isolated Piora build snapshot.",
    `hwsdk.dir=${input.profile.sdkPath.replace(/\\/g, "/")}`,
    `nodejs.dir=${dirname(input.profile.nodePath).replace(/\\/g, "/")}`,
    "",
  ].join("\n");
  writeFileSync(join(shadowRoot, "local.properties"), local, { encoding: "utf8", mode: 0o600 });
  return shadowRoot;
}

function buildArguments(profile: HarmonyBuildProfile, shadowRoot: string): { executable: string; args: string[]; wrapper: string } {
  const projectWrapper = join(shadowRoot, "hvigor", "hvigor-wrapper.js");
  const wrapper = file(projectWrapper) ? projectWrapper : profile.wrapperPath;
  return {
    executable: profile.nodePath,
    wrapper,
    args: [
      wrapper,
      "--mode", "module",
      "-p", `product=${profile.product}`,
      "-p", `module=${profile.module}@${profile.target}`,
      "-p", `buildMode=${profile.buildMode}`,
      "assembleHap",
      "--no-daemon",
    ],
  };
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const executable = join(systemRoot, "System32", "taskkill.exe");
    if (file(executable)) {
      const child = spawn(executable, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
      child.unref();
    }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  }
}

async function executeBuild(input: {
  executable: string;
  args: string[];
  cwd: string;
  profile: HarmonyBuildProfile;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ exitCode?: number; output: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean }> {
  return await new Promise((resolveResult, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: { ...process.env, NODE_HOME: dirname(input.profile.nodePath), DEVECO_SDK_HOME: input.profile.sdkPath },
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { outputTruncated = true; return; }
      const remaining = MAX_OUTPUT_BYTES - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) outputTruncated = true;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const stop = (reason: "timeout" | "cancel") => {
      if (settled) return;
      timedOut ||= reason === "timeout";
      cancelled ||= reason === "cancel";
      child.kill("SIGTERM");
      if (child.pid) killProcessTree(child.pid);
    };
    const abort = () => stop("cancel");
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), input.timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolveResult({
        ...(typeof code === "number" ? { exitCode: code } : {}),
        output: Buffer.concat(chunks).toString("utf8"),
        outputTruncated,
        timedOut,
        cancelled,
      });
    });
  });
}

function portable(value: string): string { return value.replace(/\\/g, "/"); }

function relativeDiagnosticPath(candidate: string, shadowRoot: string): string {
  const usesWindowsPath = /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate);
  if (usesWindowsPath) {
    return win32.relative(win32.resolve(shadowRoot), win32.resolve(candidate));
  }
  if (posix.isAbsolute(candidate)) {
    return posix.relative(posix.resolve(shadowRoot), posix.resolve(candidate));
  }
  return candidate;
}

export function parseHarmonyBuildDiagnostics(
  output: string,
  shadowRoot: string,
  preview: GeneratedArtifactManifest,
): DesignBuildDiagnostic[] {
  const artifactNodes = new Map(preview.artifacts.map((item) => [item.relativePath, item.sourceNodeIds]));
  const diagnostics: DesignBuildDiagnostic[] = [];
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !/(?:error|warn|failed|arkts|ets)/i.test(line)) continue;
    const location = /((?:[A-Za-z]:)?[^\s:'"]+\.(?:ets|ts|json5))(?::|\()(\d+)(?::|,)(\d+)?\)?/i.exec(line);
    let relativePath: string | undefined;
    if (location) {
      const candidate = relativeDiagnosticPath(location[1], shadowRoot);
      const normalized = portable(candidate).replace(/^\.\//, "");
      if (!normalized.startsWith("../") && !normalized.startsWith("/")) relativePath = normalized;
    }
    diagnostics.push({
      severity: /\b(?:error|failed|failure)\b/i.test(line) ? "error" : /\bwarn(?:ing)?\b/i.test(line) ? "warning" : "info",
      message: line.slice(0, 2_000),
      ...(relativePath ? { relativePath } : {}),
      ...(location?.[2] ? { line: Number(location[2]) } : {}),
      ...(location?.[3] ? { column: Number(location[3]) } : {}),
      sourceNodeIds: relativePath ? artifactNodes.get(relativePath) ?? [] : [],
    });
    if (diagnostics.length >= 200) break;
  }
  return diagnostics;
}

function findHaps(root: string, limit = 20_000): string[] {
  const haps: string[] = [];
  let seen = 0;
  const visit = (directoryPath: string) => {
    if (seen >= limit) return;
    let entries;
    try { entries = readdirSync(directoryPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      seen += 1;
      if (seen >= limit) break;
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".hap")) haps.push(path);
    }
  };
  visit(root);
  return haps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function safeLogTail(output: string, shadowRoot: string, projectRoot: string): string {
  const sanitized = output.replaceAll(shadowRoot, projectRoot).replace(/\x1b\[[0-9;]*m/g, "");
  const buffer = Buffer.from(sanitized, "utf8");
  return buffer.subarray(Math.max(0, buffer.byteLength - LOG_TAIL_BYTES)).toString("utf8");
}

export async function buildHarmonyPreview(input: {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  mode?: "preview" | "applied";
  selection?: HarmonyBuildSelection;
  runtime?: HarmonyBuildRuntimeOverride;
  workspace?: DesignPreviewWorkspace;
  dataRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DesignBuildResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let profile: HarmonyBuildProfile;
  try {
    profile = detectHarmonyBuildProfile(input.run.projectRoot, input.selection, input.runtime);
  } catch (error) {
    if (!(error instanceof DesignToHarmonyError) || error.code !== "BUILD_TOOL_NOT_FOUND") throw error;
    return {
      status: "unavailable", startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      timedOut: false, outputTruncated: false, logTail: error.message, diagnostics: [],
    };
  }
  const validationRoot = join(resolve(input.dataRoot ?? designToHarmonyDataRoot()), "validations", input.run.id, randomUUID());
  mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
  const workspace = input.workspace ?? getDesignPreviewWorkspace();
  let shadowRoot = "";
  try {
    shadowRoot = createBuildSnapshot({ run: input.run, preview: input.preview, profile, workspace, root: validationRoot, mode: input.mode ?? "preview" });
    const command = buildArguments(profile, shadowRoot);
    const result = await executeBuild({ ...command, cwd: shadowRoot, profile, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: input.signal });
    const diagnostics = parseHarmonyBuildDiagnostics(result.output, shadowRoot, input.preview);
    let hapPath: string | undefined;
    if (result.exitCode === 0 && !result.cancelled && !result.timedOut) {
      const hap = findHaps(join(shadowRoot, profile.module, "build"))[0];
      if (hap) {
        const output = join(validationRoot, `${profile.module}-${profile.target}-${profile.buildMode}.hap`);
        copyFileSync(hap, output, fsConstants.COPYFILE_FICLONE);
        hapPath = output;
      } else diagnostics.push({ severity: "error", code: "HAP_NOT_FOUND", message: "Hvigor completed without producing a HAP package.", sourceNodeIds: [] });
    }
    const completedAt = new Date().toISOString();
    const passed = result.exitCode === 0 && Boolean(hapPath) && !result.timedOut && !result.cancelled;
    return {
      status: result.cancelled ? "cancelled" : passed ? "passed" : "failed",
      startedAt,
      completedAt,
      durationMs: Date.now() - started,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      logTail: safeLogTail(result.output, shadowRoot, input.run.projectRoot),
      ...(hapPath ? { hapPath } : {}),
      profile,
      diagnostics,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      return { status: "cancelled", startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started, timedOut: false, outputTruncated: false, logTail: "Validation cancelled.", profile, diagnostics: [] };
    }
    throw error;
  } finally {
    if (shadowRoot && existsSync(shadowRoot)) {
      try { rmSync(shadowRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* bounded maintenance retries stale build snapshots later */ }
    }
  }
}
