import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { DEVECO_CLI_PATH, findHarmonyProjectRoot, inspectHarmonyCheckEnvironment } from "./harmony/check-runtime";
import type { CodeDefinition, CodeIntelligenceMode, CodeIntelligenceResult, CodeSuggestion } from "./code-intelligence-types";

export type CodeAction = "sync" | "close" | "definition" | "completion" | "hover" | "status";
export interface CodeQuery {
  action: CodeAction;
  cwd?: string;
  filePath: string;
  content?: string;
  version?: number;
  offset?: number;
}

interface Document { content: string; version: number }
interface LspRuntime { process: ChildProcessWithoutNullStreams; connection: MessageConnection; opened: Set<string> }
interface TsRuntime { worker: Worker; nextId: number; pending: Map<number, { resolve: (value: CodeIntelligenceResult) => void; reject: (error: Error) => void }> }
interface SymbolEntry extends CodeDefinition { name: string; kind: string }
interface ProjectSession {
  key: string;
  root: string;
  mode: CodeIntelligenceMode;
  message?: string;
  documents: Map<string, Document>;
  lsp?: LspRuntime;
  lspStart?: Promise<void>;
  lspRetryAt?: number;
  tsRuntime?: TsRuntime;
  symbols?: { until: number; items: SymbolEntry[] };
  pending: Promise<unknown>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

declare global { var __pioraCodeSessions: Map<string, ProjectSession> | undefined }
const sessions = globalThis.__pioraCodeSessions ??= new Map<string, ProjectSession>();
const SUPPORTED = new Set([".ets", ".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([".git", ".hvigor", ".idea", ".next", "build", "dist", "node_modules", "oh_modules"]);
const IDLE_MS = 10 * 60_000;

export function supportsCodeIntelligence(filePath: string): boolean { return SUPPORTED.has(extname(filePath).toLowerCase()); }

export function codeProjectFor(filePath: string, cwd?: string): { root: string; mode: CodeIntelligenceMode } {
  if (extname(filePath).toLowerCase() === ".ets") {
    return { root: findHarmonyProjectRoot(filePath) ?? resolve(cwd ?? dirname(filePath)), mode: "arkts-basic" };
  }
  let current = dirname(filePath);
  let config: string | undefined;
  while (true) {
    if (existsSync(join(current, "tsconfig.json"))) { config = join(current, "tsconfig.json"); break; }
    if (existsSync(join(current, "jsconfig.json"))) { config = join(current, "jsconfig.json"); break; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: config ? dirname(config) : resolve(cwd ?? dirname(filePath)), mode: "typescript" };
}

function dispose(session: ProjectSession) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.lsp?.connection.dispose();
  session.lsp?.process.kill();
  void session.tsRuntime?.worker.terminate();
  sessions.delete(session.key);
}
function touch(session: ProjectSession) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => dispose(session), IDLE_MS);
  session.idleTimer.unref?.();
}
function sessionFor(filePath: string, cwd?: string): ProjectSession {
  const project = codeProjectFor(filePath, cwd);
  const key = `${project.mode}:${project.root.toLowerCase()}`;
  let session = sessions.get(key);
  if (!session) {
    session = { key, root: project.root, mode: project.mode, documents: new Map(), pending: Promise.resolve() };
    sessions.set(key, session);
  }
  touch(session);
  return session;
}
function inOrder<T>(session: ProjectSession, task: () => Promise<T>): Promise<T> {
  const next = session.pending.then(task, task);
  session.pending = next.catch(() => undefined);
  return next;
}
function lspPosition(content: string, offset: number) {
  const before = content.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: (before.match(/\n/g) ?? []).length, character: before.length - lastBreak - 1 };
}
function location(value: unknown): CodeDefinition | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const uri = item.targetUri ?? item.uri;
  const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
  if (typeof uri !== "string" || !uri.startsWith("file:") || !range || typeof range !== "object") return null;
  const start = (range as { start?: { line?: number; character?: number } }).start;
  if (!start || !Number.isInteger(start.line) || !Number.isInteger(start.character)) return null;
  try { return { filePath: fileURLToPath(uri), line: start.line! + 1, column: start.character! + 1 }; } catch { return null; }
}
function lspLocations(value: unknown): CodeDefinition[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((item) => location(item) ? [location(item)!] : []);
}
function lspHover(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const contents = (value as { contents?: unknown }).contents;
  const parts = Array.isArray(contents) ? contents : [contents];
  const text = parts.map((part) => typeof part === "string" ? part : part && typeof part === "object"
    ? String((part as { value?: unknown }).value ?? "") : "").filter(Boolean).join("\n");
  return text.slice(0, 4000) || undefined;
}
function lspSuggestions(value: unknown): CodeSuggestion[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 250).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { label?: unknown }).label !== "string") return [];
    const item = raw as Record<string, unknown>;
    const edit = item.textEdit && typeof item.textEdit === "object" ? item.textEdit as { newText?: unknown } : null;
    const insertText = typeof edit?.newText === "string" ? edit.newText : typeof item.insertText === "string" ? item.insertText : undefined;
    const detail = typeof item.detail === "string" ? item.detail : undefined;
    const rawDocumentation = item.documentation;
    const documentation = typeof rawDocumentation === "string" ? rawDocumentation
      : rawDocumentation && typeof rawDocumentation === "object" && typeof (rawDocumentation as { value?: unknown }).value === "string"
        ? (rawDocumentation as { value: string }).value : undefined;
    return [{ label: item.label as string, ...(insertText ? { insertText } : {}), ...(detail ? { detail } : {}),
      ...(documentation ? { documentation: documentation.slice(0, 2000) } : {}), kind: String(item.kind ?? "") }];
  });
}
function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => rejectTimeout(new Error("Language service timed out")), ms);
    promise.then((value) => { clearTimeout(timer); resolveTimeout(value); }, (error) => { clearTimeout(timer); rejectTimeout(error); });
  });
}
function lspEntry(): string | null {
  const environment = inspectHarmonyCheckEnvironment();
  if (!environment.studioPath) return null;
  const candidates = [
    join(environment.studioPath, "plugins", "openharmony", "ace-server", "out", "standardIndex", "index.js"),
    join(environment.studioPath, "plugins", "openharmony", "out", "standardIndex", "index.js"),
  ];
  return candidates.some(existsSync) ? environment.studioPath : null;
}
async function startLsp(session: ProjectSession): Promise<void> {
  if (session.lsp) return;
  if (session.lspStart) return session.lspStart;
  if (session.lspRetryAt && session.lspRetryAt > Date.now()) return;
  const studioPath = lspEntry();
  if (!studioPath) {
    session.mode = "arkts-basic";
    session.message = "当前 DevEco Studio 缺少 ArkTS 语义服务，正在使用基础模式";
    session.lspRetryAt = Date.now() + 60_000;
    return;
  }
  session.lspStart = (async () => {
    const child = spawn(process.execPath, [DEVECO_CLI_PATH, "serve", "lsp", "--arkts", "--project-path", session.root], {
      cwd: session.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DEVECO_CLI_STUDIO_PATH: studioPath, DEVECO_CLI_DISABLE_TELEMETRY: "1", DEVECO_CLI_DISABLE_UPDATE: "1" },
    });
    const connection = createMessageConnection(child.stdout, child.stdin);
    connection.onRequest("workspace/configuration", (params: { items?: unknown[] }) => (params.items ?? []).map(() => null));
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "Apply edits in the Piora editor" }));
    connection.listen();
    const runtime: LspRuntime = { process: child, connection, opened: new Set() };
    child.on("exit", () => {
      if (session.lsp === runtime) {
        session.lsp = undefined;
        session.mode = "arkts-basic";
        session.message = "ArkTS 语义服务已退出，正在使用基础模式";
      }
      connection.dispose();
    });
    try {
      await timeout(connection.sendRequest("initialize", {
        processId: process.pid, rootUri: pathToFileURL(session.root).href, rootPath: session.root,
        capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } }, definition: {}, hover: {}, synchronization: {} } },
        workspaceFolders: [{ uri: pathToFileURL(session.root).href, name: session.root.split(/[\\/]/).pop() }],
      }), 20_000);
      await connection.sendNotification("initialized", {});
      session.lsp = runtime;
      session.lspRetryAt = undefined;
      session.mode = "arkts-lsp";
      session.message = undefined;
      for (const [filePath, doc] of session.documents) await syncLsp(session, filePath, doc);
    } catch (error) {
      connection.dispose(); child.kill();
      session.mode = "arkts-basic";
      session.message = `ArkTS 语义服务未就绪，正在使用基础模式：${error instanceof Error ? error.message : String(error)}`;
      session.lspRetryAt = Date.now() + 30_000;
    }
  })().finally(() => { session.lspStart = undefined; });
  return session.lspStart;
}
async function syncLsp(session: ProjectSession, filePath: string, doc: Document) {
  const lsp = session.lsp;
  if (!lsp) return;
  const uri = pathToFileURL(filePath).href;
  if (lsp.opened.has(filePath)) await lsp.connection.sendNotification("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text: doc.content }] });
  else {
    await lsp.connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "arkts", version: doc.version, text: doc.content } });
    lsp.opened.add(filePath);
  }
}
async function updateDocument(session: ProjectSession, filePath: string, content: string | undefined, version: number | undefined) {
  if (content === undefined) return;
  const previous = session.documents.get(filePath);
  const nextVersion = Number.isSafeInteger(version) && version! > 0 ? version! : Date.now();
  if (previous && previous.version > nextVersion) return;
  if (previous && previous.content === content) return;
  const doc = { content, version: nextVersion };
  session.documents.set(filePath, doc);
  if (session.mode === "arkts-basic" || session.mode === "arkts-lsp") {
    const alreadyOpen = session.lsp?.opened.has(filePath) ?? false;
    await startLsp(session);
    if (session.lsp && (alreadyOpen || !session.lsp.opened.has(filePath))) await syncLsp(session, filePath, doc);
  }
}

const TS_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(workerData.typescriptPath);
const documents = new Map();
const configPath = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(workerData.root, name)).find(fs.existsSync);
const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : null;
const parsed = configPath && config && !config.error ? ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)) : null;
const options = parsed?.options ?? { allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
let service;
function languageService() {
  if (service) return service;
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...documents.keys()],
    getScriptVersion: name => String(documents.get(path.resolve(name))?.version ?? (() => { try { return fs.statSync(name).mtimeMs; } catch { return 0; } })()),
    getScriptSnapshot: name => { const text = documents.get(path.resolve(name))?.content ?? ts.sys.readFile(name); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => workerData.root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists, realpath: ts.sys.realpath,
  };
  service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return service;
}
parentPort.on('message', ({ id, query }) => {
  try {
    const filePath = path.resolve(query.filePath);
    if (query.action === 'close') documents.delete(filePath);
    else if (query.content !== undefined) {
      const old = documents.get(filePath);
      if (!old || old.version <= query.version) documents.set(filePath, { content: query.content, version: query.version });
    }
    const result = { mode: 'typescript' };
    if (query.action === 'definition') {
      result.definitions = (languageService().getDefinitionAtPosition(filePath, query.offset) ?? []).map(entry => {
        const text = documents.get(path.resolve(entry.fileName))?.content ?? ts.sys.readFile(entry.fileName) ?? '';
        const before = text.slice(0, entry.textSpan.start);
        return { filePath: path.resolve(entry.fileName), line: (before.match(/\n/g) ?? []).length + 1,
          column: before.length - before.lastIndexOf('\n'), name: entry.name };
      });
    } else if (query.action === 'completion') {
      const entries = (languageService().getCompletionsAtPosition(filePath, query.offset,
        { includeCompletionsForModuleExports: false, includeInsertTextCompletions: true })?.entries ?? []).slice(0, 250);
      result.suggestions = entries.map((entry, index) => {
        let details;
        if (index < 30) try {
          details = languageService().getCompletionEntryDetails(filePath, query.offset, entry.name,
            undefined, entry.source, undefined, entry.data);
        } catch { /* A single unsupported entry must not discard the list. */ }
        const signature = details ? ts.displayPartsToString(details.displayParts) : '';
        const documentation = details ? ts.displayPartsToString(details.documentation) : '';
        return { label: entry.name, insertText: entry.insertText, detail: signature || entry.kind,
          documentation: documentation.slice(0, 2000), kind: entry.kind };
      });
    } else if (query.action === 'hover') {
      const info = languageService().getQuickInfoAtPosition(filePath, query.offset);
      if (info) result.hover = [ts.displayPartsToString(info.displayParts), ts.displayPartsToString(info.documentation)].filter(Boolean).join('\n').slice(0, 4000);
    }
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
`;
function typeScriptWorker(session: ProjectSession): TsRuntime {
  if (session.tsRuntime) return session.tsRuntime;
  const runtimeRoot = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  const typescriptPath = join(runtimeRoot, "node_modules", "typescript", "lib", "typescript.js");
  const worker = new Worker(TS_WORKER_SOURCE, { eval: true, workerData: { root: session.root, typescriptPath } });
  worker.unref();
  const runtime: TsRuntime = { worker, nextId: 0, pending: new Map() };
  function fail(error: Error) {
    for (const waiter of runtime.pending.values()) waiter.reject(error);
    runtime.pending.clear();
    if (session.tsRuntime === runtime) session.tsRuntime = undefined;
  }
  worker.on("message", (value: { id: number; result?: CodeIntelligenceResult; error?: string }) => {
    const waiter = runtime.pending.get(value.id);
    if (!waiter) return;
    runtime.pending.delete(value.id);
    if (value.error) waiter.reject(new Error(value.error));
    else waiter.resolve(value.result ?? { mode: "typescript" });
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`TypeScript service exited (${code})`)));
  session.tsRuntime = runtime;
  return runtime;
}
async function tsResult(session: ProjectSession, query: CodeQuery): Promise<CodeIntelligenceResult> {
  const runtime = typeScriptWorker(session);
  const id = ++runtime.nextId;
  const request = new Promise<CodeIntelligenceResult>((resolveResult, rejectResult) => {
    runtime.pending.set(id, { resolve: resolveResult, reject: rejectResult });
    runtime.worker.postMessage({ id, query: { ...query, filePath: resolve(query.filePath) } });
  });
  try { return await timeout(request, 20_000); }
  catch (error) {
    runtime.pending.delete(id);
    if (session.tsRuntime === runtime) { session.tsRuntime = undefined; void runtime.worker.terminate(); }
    throw error;
  }
}

function scanSymbols(filePath: string, content: string): SymbolEntry[] {
  const items: SymbolEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const declaration = lines[line].match(/^\s*(?:(?:export|default|declare|abstract)\s+)*(class|interface|struct|enum|function|type|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) items.push({ filePath, line: line + 1, column: lines[line].indexOf(declaration[2]) + 1, name: declaration[2], kind: declaration[1] });
    const method = lines[line].match(/^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{}]+)?\s*\{/);
    if (method && !["if", "for", "while", "switch", "catch"].includes(method[1])) items.push({ filePath, line: line + 1, column: lines[line].indexOf(method[1]) + 1, name: method[1], kind: "method" });
  }
  return items;
}
function projectSymbols(session: ProjectSession): SymbolEntry[] {
  if (session.symbols && session.symbols.until > Date.now()) return session.symbols.items;
  const items: SymbolEntry[] = [];
  let visited = 0;
  function walk(directory: string) {
    if (visited >= 2500) return;
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= 2500) break;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(target); continue; }
      if (!entry.isFile() || !SUPPORTED.has(extname(entry.name).toLowerCase())) continue;
      visited++;
      try {
        if (statSync(target).size > 1024 * 1024) continue;
        items.push(...scanSymbols(target, session.documents.get(target)?.content ?? readFileSync(target, "utf8")));
      } catch { /* Unreadable files do not prevent other symbols from loading. */ }
    }
  }
  walk(session.root);
  session.symbols = { until: Date.now() + 15_000, items };
  return items;
}
function wordAt(content: string, offset: number): { word: string; start: number; member: boolean } {
  let start = Math.max(0, Math.min(offset, content.length));
  let end = start;
  if (!/[\w$]/.test(content[start] ?? "") && start > 0) start--;
  while (start > 0 && /[\w$]/.test(content[start - 1])) start--;
  while (end < content.length && /[\w$]/.test(content[end])) end++;
  return { word: content.slice(start, end), start, member: content.slice(0, start).trimEnd().endsWith(".") };
}
function importedSymbol(content: string, name: string): { source: string; original: string } | null {
  const pattern = /import\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    if (match[2] === name) return { source: match[3], original: "default" };
    for (const part of (match[1] ?? "").split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      if ((bits[1] ?? bits[0]) === name) return { source: match[3], original: bits[0] };
    }
  }
  return null;
}
function importTarget(root: string, filePath: string, source: string): string | null {
  if (!source.startsWith(".")) return null;
  const base = resolve(dirname(filePath), source);
  for (const candidate of [base, ...[".ets", ".ts", ".tsx", ".js", ".jsx"].map((ext) => base + ext), ...[".ets", ".ts", ".tsx", ".js", ".jsx"].map((ext) => join(base, "index" + ext))]) {
    try {
      if (!statSync(candidate).isFile()) continue;
      const inside = relative(realpathSync(root), realpathSync(candidate));
      if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return candidate;
    } catch { /* Try the next extension. */ }
  }
  return null;
}
function basicResult(session: ProjectSession, query: CodeQuery, content: string, offset: number): CodeIntelligenceResult {
  const openPaths = new Set([...session.documents.keys()].map((file) => file.toLowerCase()));
  const symbols = projectSymbols(session).filter((item) => !openPaths.has(item.filePath.toLowerCase()));
  for (const [file, doc] of session.documents) symbols.push(...scanSymbols(file, doc.content));
  const result: CodeIntelligenceResult = { mode: "arkts-basic", message: session.message ?? "ArkTS 基础模式：仅提供明确符号的跳转与补全" };
  const token = wordAt(content, offset);
  if (query.action === "definition") {
    if (!token.word || token.member) { result.definitions = []; return result; }
    const imported = importedSymbol(content, token.word);
    const target = imported && importTarget(session.root, query.filePath, imported.source);
    const name = imported?.original === "default" ? token.word : imported?.original ?? token.word;
    if (target && !symbols.some((item) => item.filePath.toLowerCase() === target.toLowerCase())) {
      try { symbols.push(...scanSymbols(target, session.documents.get(target)?.content ?? readFileSync(target, "utf8"))); } catch { /* The import target may have disappeared. */ }
    }
    let candidates = symbols.filter((item) => item.name === name && item.kind !== "method");
    if (target) candidates = candidates.filter((item) => resolve(item.filePath).toLowerCase() === target.toLowerCase());
    else {
      const local = candidates.filter((item) => resolve(item.filePath).toLowerCase() === resolve(query.filePath).toLowerCase());
      if (local.length) candidates = local;
    }
    if (!candidates.length && !token.member) candidates = symbols.filter((item) => item.name === name && item.kind === "method" && item.filePath === query.filePath);
    result.definitions = candidates.slice(0, 12);
  } else if (query.action === "completion") {
    if (token.member) { result.suggestions = []; return result; }
    const names = new Map<string, SymbolEntry>();
    for (const item of symbols) if (!names.has(item.name) || item.filePath === query.filePath) names.set(item.name, item);
    result.suggestions = [...names.values()].filter((item) => !token.word || item.name.toLowerCase().startsWith(token.word.toLowerCase()))
      .slice(0, 100).map((item) => ({ label: item.name, detail: `${item.kind} · ${relative(session.root, item.filePath)}`, kind: item.kind }));
  } else if (query.action === "hover") {
    const item = symbols.find((candidate) => candidate.name === token.word && candidate.filePath === query.filePath)
      ?? symbols.find((candidate) => candidate.name === token.word);
    if (item) result.hover = `${item.kind} ${item.name}\n${relative(session.root, item.filePath)}:${item.line}`;
  }
  return result;
}

export async function runCodeQuery(query: CodeQuery): Promise<CodeIntelligenceResult> {
  const filePath = resolve(query.filePath);
  const session = sessionFor(filePath, query.cwd);
  return inOrder(session, async () => {
    if (query.action === "close") {
      session.documents.delete(filePath);
      session.symbols = undefined;
      if (session.lsp?.opened.delete(filePath)) await session.lsp.connection.sendNotification("textDocument/didClose", { textDocument: { uri: pathToFileURL(filePath).href } });
      if (session.mode === "typescript" && session.tsRuntime) await tsResult(session, { action: "close", filePath });
      const result = { mode: session.mode, message: session.message };
      if (!session.documents.size) dispose(session);
      return result;
    }
    await updateDocument(session, filePath, query.content, query.version);
    if (query.action === "sync" || query.action === "status") {
      if (query.action === "status" && session.mode === "arkts-basic") await startLsp(session);
      if (session.mode === "typescript") await tsResult(session, { ...query, filePath });
      return { mode: session.mode, message: session.message };
    }
    const content = session.documents.get(filePath)?.content ?? readFileSync(filePath, "utf8");
    const offset = Math.max(0, Math.min(query.offset ?? 0, content.length));
    if (session.mode === "typescript") return tsResult(session, { ...query, filePath, content, version: session.documents.get(filePath)?.version ?? Date.now(), offset });
    if (session.lsp) {
      try {
        const params = { textDocument: { uri: pathToFileURL(filePath).href }, position: lspPosition(content, offset) };
        const method = query.action === "definition" ? "textDocument/definition" : query.action === "completion" ? "textDocument/completion" : "textDocument/hover";
        const value: unknown = await timeout(session.lsp.connection.sendRequest(method, params), 8_000);
        return { mode: "arkts-lsp", ...(query.action === "definition" ? { definitions: lspLocations(value) }
          : query.action === "completion" ? { suggestions: lspSuggestions(value) } : { hover: lspHover(value) }) };
      } catch (error) {
        session.lsp.connection.dispose(); session.lsp.process.kill(); session.lsp = undefined;
        session.mode = "arkts-basic";
        session.message = `ArkTS 语义服务暂不可用，正在使用基础模式：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return basicResult(session, { ...query, filePath }, content, offset);
  });
}
