import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type NativeMcpOptions = NonNullable<Parameters<typeof createMcpExtension>[0]>;
export type NativeMcpEntry = Parameters<NonNullable<NativeMcpOptions["createTransport"]>>[0];
export type NativeMcpConfig = NativeMcpEntry["config"];
export type NativeMcpExposure = NonNullable<NativeMcpConfig["exposure"]>;
type LoadedConfig = ReturnType<NonNullable<NativeMcpOptions["loadConfig"]>>;
type Json = Record<string, unknown>;
export interface NativeMcpPreferences { enabled: boolean; approvedRegistered: string[] }
const SERVER_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
export const NATIVE_MCP_EXPOSURES: readonly NativeMcpExposure[] = ["direct", "deferred", "codemode", "hidden"];
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function readConfig(path: string): Json {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error("MCP config must be a bounded regular file");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("MCP config is not strict JSON"); }
  if (!object(parsed)) throw new Error("MCP config must be an object");
  return parsed;
}

function recordOfStrings(value: unknown): boolean {
  return value === undefined || object(value) && Object.values(value).every(entry => typeof entry === "string");
}
function safeUrl(value: string): URL { try { return new URL(value); } catch { throw new Error("Invalid MCP URL"); } }
function checkConfigParents(root: string, path: string): void {
  const parts = relative(resolve(root), resolve(path)).split(sep);
  if (parts.includes("..")) throw new Error("MCP config is outside its settings directory");
  let current = resolve(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) throw new Error("MCP settings directories must not be symbolic links");
  }
}
function rejectCommands(value: unknown): void {
  if (typeof value === "string" && value.startsWith("!")) throw new Error("Use environment references instead of MCP config commands");
}
function loopback(url: URL): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }

export function validateNativeMcpConfig(value: unknown, scope: "global" | "project"): NativeMcpConfig {
  if (!object(value)) throw new Error("MCP server must be an object");
  if (value.disabled !== undefined) throw new Error("Native Pi uses enabled:false; legacy adapter configuration is separate");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("MCP enabled must be boolean");
  if (value.exposure !== undefined && !NATIVE_MCP_EXPOSURES.includes(value.exposure as NativeMcpExposure)) throw new Error("Unsupported MCP exposure");
  if (value.toolExposure !== undefined && (!object(value.toolExposure) || Object.values(value.toolExposure).some(exposure => !NATIVE_MCP_EXPOSURES.includes(exposure as NativeMcpExposure)))) throw new Error("Invalid MCP tool exposure");
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)) throw new Error("Invalid MCP timeout");
  if (value.description !== undefined && typeof value.description !== "string") throw new Error("Invalid MCP description");
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || value.command !== undefined || value.type !== undefined && value.type !== "http") throw new Error("Use Streamable HTTP, not legacy SSE");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new Error("Invalid MCP URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP URL");
    if (!recordOfStrings(value.headers)) throw new Error("Invalid MCP headers");
    for (const header of Object.values(value.headers ?? {})) rejectCommands(header);
    if (value.auth !== undefined && (scope === "project" || !object(value.auth) || typeof value.auth.provider !== "string" || url.protocol !== "https:" && !loopback(url))) throw new Error("Provider authentication is restricted to global HTTPS or loopback configuration");
    if (value.oauth !== undefined) {
      if (!object(value.oauth)) throw new Error("Invalid MCP OAuth configuration");
      for (const key of ["clientId", "clientSecret", "scope", "clientName", "callbackUrl", "authServerMetadataUrl"]) {
        if (value.oauth[key] !== undefined && typeof value.oauth[key] !== "string") throw new Error("Invalid MCP OAuth configuration");
      }
      if (value.oauth.callbackPort !== undefined && (!Number.isInteger(value.oauth.callbackPort) || Number(value.oauth.callbackPort) < 1 || Number(value.oauth.callbackPort) > 65535)) throw new Error("Invalid MCP callback port");
      if (value.oauth.callbackUrl !== undefined) {
        const callback = safeUrl(String(value.oauth.callbackUrl));
        if (callback.protocol !== "http:" || !loopback(callback) || callback.username || callback.password || callback.search || callback.hash) throw new Error("MCP OAuth callback must be loopback");
      }
      if (value.oauth.authServerMetadataUrl !== undefined) {
        const metadata = safeUrl(String(value.oauth.authServerMetadataUrl));
        if (metadata.protocol !== "https:" && !(metadata.protocol === "http:" && loopback(metadata))) throw new Error("Invalid MCP OAuth metadata URL");
      }
      rejectCommands(value.oauth.clientSecret);
      if (value.oauth.clientRegistration !== undefined && !["dcr", "cimd"].includes(String(value.oauth.clientRegistration))) throw new Error("Invalid MCP OAuth registration");
    }
  } else {
    if (typeof value.command !== "string" || !value.command.trim() || value.type !== undefined && value.type !== "stdio") throw new Error("Use a stdio command or Streamable HTTP URL");
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string"))) throw new Error("Invalid MCP arguments");
    for (const entry of Object.values(object(value.env) ? value.env : {})) rejectCommands(entry);
    if (!recordOfStrings(value.env) || value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("Invalid MCP environment or working directory");
  }
  return value as unknown as NativeMcpConfig;
}

export function nativeMcpPreferencesPath(agentDir: string): string { return join(agentDir, "piora/mcp-native.json"); }
export function readNativeMcpPreferences(agentDir: string): NativeMcpPreferences {
  const value = readConfig(nativeMcpPreferencesPath(agentDir));
  return { enabled: value.enabled === true, approvedRegistered: Array.isArray(value.approvedRegistered) ? value.approvedRegistered.filter((id): id is string => typeof id === "string") : [] };
}
export function writeNativeMcpPreferences(agentDir: string, preferences: NativeMcpPreferences): void {
  const path = nativeMcpPreferencesPath(agentDir);
  checkConfigParents(agentDir, path);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(preferences, null, 2)}\n`);
}
export function nativeMcpApprovalIdentity(cwd: string, name: string, source: string, config: NativeMcpConfig): string {
  return createHash("sha256").update(JSON.stringify([cwd, name, source, config])).digest("hex");
}

// Deliberately separate native Pi's two strict-JSON sources from the legacy
// adapter's six JSONC sources and cache. Do not silently import or execute them.
export function loadNativeMcpConfig(agentDir: string, cwd: string, projectTrusted: boolean): LoadedConfig {
  const servers = new Map<string, NativeMcpEntry>();
  const errors: string[] = [];
  let autoEnableCodemode: boolean | undefined;
  const projectConfig = join(cwd, ".pi/mcp.json");
  const scopes: Array<"global" | "project"> = projectTrusted ? ["global", "project"] : ["global"];
  for (const scope of scopes) {
    const path = scope === "global" ? join(agentDir, "mcp.json") : projectConfig;
    try {
      checkConfigParents(scope === "global" ? agentDir : cwd, path);
      const file = readConfig(path);
      if (!existsSync(path)) continue;
      if (file.autoEnableCodemode !== undefined && typeof file.autoEnableCodemode !== "boolean") throw new Error("Invalid autoEnableCodemode");
      if (typeof file.autoEnableCodemode === "boolean") autoEnableCodemode = file.autoEnableCodemode;
      if (!object(file.mcpServers)) throw new Error("Missing mcpServers object");
      if (Object.keys(file.mcpServers).length > 64) throw new Error("Too many MCP servers");
      for (const [name, raw] of Object.entries(file.mcpServers)) {
        try {
          if (!SERVER_NAME.test(name) || !object(raw)) throw new Error("Invalid server name or definition");
          const previous = servers.get(name);
          if ([...servers.keys()].some(other => other !== name && other.replace(/-/g, "_") === name.replace(/-/g, "_"))) throw new Error("Ambiguous MCP namespace");
          if (scope === "project" && raw.command === undefined && raw.url === undefined && raw.type === undefined) {
            if (!previous || Object.keys(raw).some(key => !["enabled", "exposure", "toolExposure"].includes(key))) throw new Error("Project overrides may change only enabled and exposure settings");
            servers.set(name, { ...previous, config: validateNativeMcpConfig({ ...previous.config, ...raw }, "global"), override: path });
          } else servers.set(name, { name, config: validateNativeMcpConfig(raw, scope), source: path, scope });
        } catch { errors.push(`${scope}: invalid MCP server ${name.slice(0, 100)}`); }
      }
    } catch (error) { errors.push(`${scope}: ${error instanceof Error ? error.message : "Invalid MCP configuration"}`); }
  }
  return { servers: [...servers.values()], errors, autoEnableCodemode, ...(projectTrusted ? { projectConfig } : {}) };
}

export function updateNativeMcpServer(agentDir: string, cwd: string, projectTrusted: boolean, input: {
  name: string; scope: "global" | "project"; config?: unknown; enabled?: boolean; exposure?: NativeMcpExposure; remove?: boolean;
}): void {
  if (!SERVER_NAME.test(input.name)) throw new Error("Invalid MCP server name");
  if (input.scope === "project" && !projectTrusted) throw new Error("Project MCP configuration requires existing project trust");
  const path = input.scope === "global" ? join(agentDir, "mcp.json") : join(cwd, ".pi/mcp.json");
  checkConfigParents(input.scope === "global" ? agentDir : cwd, path);
  const file = readConfig(path);
  const servers = object(file.mcpServers) ? { ...file.mcpServers } : {};
  if (input.remove) delete servers[input.name];
  else if (input.config !== undefined) servers[input.name] = validateNativeMcpConfig(input.config, input.scope);
  else {
    const existing = servers[input.name];
    if (input.scope === "global" && !object(existing)) throw new Error("MCP server not found in requested scope");
    const effective = loadNativeMcpConfig(agentDir, cwd, projectTrusted).servers.find(entry => entry.name === input.name);
    if (!effective) throw new Error("MCP server not found");
    servers[input.name] = { ...(object(existing) ? existing : {}), ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}), ...(input.exposure ? { exposure: input.exposure } : {}) };
    // Validate the effective combination without copying global credentials into
    // a project override. Project full definitions replace, never shallow-merge.
    validateNativeMcpConfig({ ...effective.config, ...servers[input.name] as Json }, effective.scope === "project" ? "project" : "global");
  }
  if (Object.keys(servers).length > 64) throw new Error("Too many MCP servers");
  if (Object.keys(servers).some(other => other !== input.name && other.replace(/-/g, "_") === input.name.replace(/-/g, "_"))) throw new Error("Ambiguous MCP namespace");
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ ...file, mcpServers: servers }, null, 2)}\n`);
}
