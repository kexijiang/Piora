import { existsSync, lstatSync, readFileSync } from "node:fs";
import { getRuntimeUserHomeDirectory as homedir } from "./runtime-home";
import { join } from "node:path";
import type {
  McpCapabilitiesInfo,
  McpServerCapability,
  McpToolCapability,
  McpTransportKind,
} from "@/lib/api-types";

const CONFIG_MAX_BYTES = 1024 * 1024;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SERVERS = 64;
const MAX_TOOLS_PER_SERVER = 500;
const MAX_DESCRIPTION_LENGTH = 500;

type JsonObject = Record<string, unknown>;

interface ConfiguredServer {
  definition: JsonObject;
  source: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCP config files commonly allow JSON comments. Keep string contents intact while
// removing only // and /* */ comments before JSON.parse().
export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") {
        lineComment = false;
        output += current;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        index += 1;
      } else {
        output += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
    } else if (current === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index += 1;
    } else {
      output += current;
    }
  }
  return output;
}

function readBoundedJson(path: string, maxBytes: number): unknown {
  const fileStats = lstatSync(path);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error("not a regular file");
  }
  if (fileStats.size > maxBytes) throw new Error("file is too large");
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function transportFor(definition: JsonObject): McpTransportKind {
  if (typeof definition.command === "string") return "stdio";
  if (typeof definition.url === "string") return "http";
  if (typeof definition.socket === "string") return "socket";
  return "unknown";
}

function cleanTools(value: unknown): McpToolCapability[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOLS_PER_SERVER).flatMap((candidate) => {
    if (!isObject(candidate) || typeof candidate.name !== "string" || !candidate.name.trim()) return [];
    const description = typeof candidate.description === "string"
      ? candidate.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : "";
    return [{
      name: candidate.name.trim().slice(0, 200),
      ...(description ? { description } : {}),
    }];
  });
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function inspectMcpCapabilities(
  cwd: string,
  agentDir: string,
  now = Date.now(),
  homeDirectory = homedir(),
): McpCapabilitiesInfo {
  const setupPath = join(cwd, ".mcp.json");
  const diagnostics: string[] = [];
  const sources = [
    { label: "~/.config/mcp/mcp.json", path: join(homeDirectory, ".config", "mcp", "mcp.json") },
    { label: "~/.agents/mcp.json", path: join(homeDirectory, ".agents", "mcp.json") },
    { label: "~/.agents/mcp/mcp.json", path: join(homeDirectory, ".agents", "mcp", "mcp.json") },
    { label: "Pi global", path: join(agentDir, "mcp.json") },
    { label: "project .mcp.json", path: setupPath },
    { label: "project .pi/mcp.json", path: join(cwd, ".pi", "mcp.json") },
  ];
  const configured = new Map<string, ConfiguredServer>();

  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    try {
      const parsed = readBoundedJson(source.path, CONFIG_MAX_BYTES);
      const servers = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers : undefined;
      if (!servers) {
        diagnostics.push(`${source.label}: missing mcpServers object`);
        continue;
      }
      for (const [name, definition] of Object.entries(servers).slice(0, MAX_SERVERS)) {
        if (!name.trim() || !isObject(definition)) continue;
        const previous = configured.get(name);
        configured.set(name, {
          definition: previous ? { ...previous.definition, ...definition } : definition,
          source: source.label,
        });
      }
    } catch (error) {
      diagnostics.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let cachedServers: JsonObject = {};
  const cachePath = join(agentDir, "mcp-cache.json");
  if (existsSync(cachePath)) {
    try {
      const parsed = readBoundedJson(cachePath, CACHE_MAX_BYTES);
      if (isObject(parsed) && isObject(parsed.servers)) cachedServers = parsed.servers;
      else diagnostics.push("MCP metadata cache has an invalid servers object");
    } catch (error) {
      diagnostics.push(`MCP metadata cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const servers: McpServerCapability[] = [...configured.entries()]
    .slice(0, MAX_SERVERS)
    .map(([name, configuredServer]) => {
      const definition = configuredServer.definition;
      const disabled = definition.disabled === true;
      const cached = isObject(cachedServers[name]) ? cachedServers[name] : undefined;
      const cachedAtMs = cached
        && typeof cached.cachedAt === "number"
        && Number.isFinite(cached.cachedAt)
        && cached.cachedAt > 0
        && cached.cachedAt <= 8.64e15
        ? cached.cachedAt
        : undefined;
      const fresh = cachedAtMs !== undefined && cachedAtMs > 0 && now - cachedAtMs <= CACHE_MAX_AGE_MS;
      const tools = cached ? cleanTools(cached.tools) : [];
      return {
        name: name.slice(0, 200),
        source: configuredServer.source,
        transport: transportFor(definition),
        status: disabled ? "disabled" : fresh ? "cached" : cached ? "stale" : "configured",
        tools,
        toolCount: tools.length,
        resourceCount: cached ? countArray(cached.resources) : 0,
        promptCount: cached ? countArray(cached.prompts) : 0,
        ...(cachedAtMs ? { cachedAt: new Date(cachedAtMs).toISOString() } : {}),
      } satisfies McpServerCapability;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    serverCount: servers.length,
    enabledServerCount: servers.filter((server) => server.status !== "disabled").length,
    discoveredToolCount: servers
      .filter((server) => server.status === "cached")
      .reduce((total, server) => total + server.toolCount, 0),
    setupPath,
    servers,
    diagnostics: diagnostics.slice(0, 20),
  };
}
