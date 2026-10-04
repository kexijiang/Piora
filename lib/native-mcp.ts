import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type InlineExtension, type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import {
  loadNativeMcpConfig, nativeMcpApprovalIdentity, readNativeMcpPreferences,
  writeNativeMcpPreferences, validateNativeMcpConfig, type NativeMcpEntry, type NativeMcpOptions,
} from "./native-mcp-config";
import type { SessionCapabilityItem } from "./session-capabilities";

const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
export const nativeMcpResourceCapabilityId = (server: string) => `mcp-resource:${server}`;
export type NativeMcpState = "configured" | "disabled" | "approval-required" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
export interface NativeMcpServerState {
  name: string; source: string; scope: "global" | "project" | "extension";
  transport: "stdio" | "http"; endpoint: string; exposure: string;
  state: NativeMcpState; tools: Array<{ name: string; exposure: ToolExposure }>;
  resources: boolean; owner: "native" | "replacement"; approvalRequired?: boolean; configurationCurrent?: boolean; connectionAuthorized?: boolean;
}
type Permission = (tool: string, input?: Record<string, unknown>) => boolean;

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") || process.platform === "win32" && value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
}
function environmentValue(value: string): string {
  // Do not introduce config-command execution to the host. Existing env
  // references work; !cmd must be replaced explicitly with an env reference.
  if (value.startsWith("!")) throw new Error("Native Piora MCP accepts environment references, not config commands");
  return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
    if (match === "$$") return "$";
    if (match === "$!") return "!";
    const resolved = process.env[braced ?? plain!];
    if (!resolved) throw new Error("MCP references an unavailable environment variable");
    return resolved;
  });
}

// The SDK owns MCP connections, tool conversion, OAuth, refresh, cancellation
// and reconnect semantics. This bridge uses only public factories/transports.
// It observes transport lifecycle and enforces the host's policy at every call.
export class NativeMcpController {
  readonly factories: InlineExtension[];
  projectTrusted = false;
  private permission: Permission = () => false;
  private resourcePermission: (server: string) => boolean = () => false;
  private changed: () => void = () => {};
  private nativeStarted = false;
  private loadedConfigRevision: string | undefined;
  private loadedEnabled = false;
  private loadedRegisteredApprovals = new Map<string, boolean>();
  private shuttingDown = false;
  private states = new Map<string, NativeMcpServerState>();
  private entries = new Map<string, NativeMcpEntry>();
  private registeredApprovals = new Map<string, string>();
  private definitions = new Map<string, { exposure: ToolExposure; server?: string }>();
  private revealed = new Set<string>();
  private secrets = new Set<string>();
  private notificationQueued = false;

  constructor(readonly cwd: string, readonly agentDir: string, options: NativeMcpOptions = {}) {
    const mcp = createMcpExtension({
      ...options,
      logPath: options.logPath ?? join(agentDir, "mcp.log"),
      loadConfig: ctx => {
        this.projectTrusted = ctx.isProjectTrusted();
        const config = options.loadConfig?.(ctx) ?? loadNativeMcpConfig(agentDir, cwd, this.projectTrusted);
        const enabled = readNativeMcpPreferences(agentDir).enabled;
        this.loadedConfigRevision = this.configRevision(config);
        this.loadedEnabled = enabled;
        this.loadedRegisteredApprovals.clear();
        this.entries.clear(); this.states.clear(); this.registeredApprovals.clear(); this.revealed.clear();
        for (const [name, definition] of this.definitions) if (definition.server) this.definitions.delete(name);
        for (const entry of config.servers) this.observeEntry(entry, enabled);
        return { ...config, servers: config.servers.map(entry => ({ ...entry, config: { ...entry.config, enabled: enabled && entry.config.enabled !== false } })) };
      },
      createTransport: (entry, workingDirectory, auth) => {
        this.assertServerAuthorized(entry.name);
        const observedAuth = auth ? { token: async () => { this.assertServerAuthorized(entry.name); const token = await auth.token(); this.assertServerAuthorized(entry.name); if (token) this.rememberSecret(token); return token; },
          ...(auth.onUnauthorized ? { onUnauthorized: async (...args: Parameters<NonNullable<typeof auth.onUnauthorized>>) => { this.assertServerAuthorized(entry.name); await auth.onUnauthorized!(...args); this.assertServerAuthorized(entry.name); } } : {}) } : undefined;
        return this.observeTransport(entry, options.createTransport?.(entry, workingDirectory, observedAuth) ?? this.transport(entry, workingDirectory, observedAuth));
      },
      updateConfig: () => { throw new Error("Manage native MCP configuration in Piora Settings > Plugins"); },
    });
    this.factories = [
      { name: "piora-capability-policy", factory: pi => {
        pi.on("tool_call", event => {
          if (!this.isAllowed(event.toolName, event.input)) return { block: true, reason: "This tool is disabled by the Piora session capability policy." };
        });
      } },
      { name: "piora-native-mcp", replaceable: true, factory: pi => mcp(this.api(pi, "mcp")) },
      { name: "piora-codemode", replaceable: true, factory: pi => createCodemodeExtension({ models: false, mode: "on" })(this.api(pi, "codemode")) },
      { name: "piora-tool-search", replaceable: true, factory: pi => createToolSearchExtension()(this.api(pi, "search")) },
    ];
  }

  bind(permission: Permission, resources: (server: string) => boolean, changed: () => void): void {
    this.permission = permission; this.resourcePermission = resources; this.changed = changed;
  }
  private announce(): void {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => { this.notificationQueued = false; this.changed(); });
  }
  isAvailable(name: string): boolean { return this.definitions.get(name)?.exposure !== "hidden"; }
  private canDiscover(name: string): boolean {
    if (!RESOURCE_TOOLS.has(name)) return this.isAllowed(name);
    return [...this.states.values()].some(server => this.isAllowed(name, { server: server.name }));
  }
  isAllowed(name: string, input?: Record<string, unknown>): boolean {
    if (!this.isAvailable(name) || !this.permission(name, input)) return false;
    const serverOwner = this.definitions.get(name)?.server;
    if (serverOwner && !this.isServerAuthorized(serverOwner)) return false;
    if (RESOURCE_TOOLS.has(name)) {
      const server = input?.server;
      // Upstream's no-server aggregate listing crosses server boundaries. Require
      // an explicit authorized server for both direct and codemode calls.
      return typeof server === "string" && this.isServerAuthorized(server) && this.resourcePermission(server)
        && this.states.get(server)?.resources === true && this.states.get(server)?.exposure !== "hidden"
        && !["disabled", "approval-required", "closed"].includes(this.states.get(server)!.state);
    }
    return true;
  }
  private configurationIsCurrent(server: string): boolean {
    try {
      const entry = this.entries.get(server);
      if (!entry) return false;
      if (entry.scope === "extension") return true;
      const current = loadNativeMcpConfig(this.agentDir, this.cwd, this.projectTrusted).servers.find(candidate => candidate.name === server);
      return !!current && nativeMcpApprovalIdentity(this.cwd, server, current.source, current.config) === nativeMcpApprovalIdentity(this.cwd, server, entry.source, entry.config);
    } catch { return false; }
  }
  private isServerAuthorized(server: string): boolean {
    try {
      const preferences = readNativeMcpPreferences(this.agentDir);
      if (!preferences.enabled) return false;
      const entry = this.entries.get(server);
      if (!entry || entry.config.enabled === false) return false;
      const identity = nativeMcpApprovalIdentity(this.cwd, server, entry.source, entry.config);
      if (entry.scope === "extension") return preferences.approvedRegistered.includes(identity);
      const current = loadNativeMcpConfig(this.agentDir, this.cwd, this.projectTrusted).servers.find(candidate => candidate.name === server);
      return !!current && current.config.enabled !== false
        && nativeMcpApprovalIdentity(this.cwd, server, current.source, current.config) === identity;
    } catch { return false; }
  }
  private assertServerAuthorized(server: string): void {
    if (!this.isServerAuthorized(server)) throw new Error("Native MCP connection authorization was revoked or its configuration changed. Reload after approving the current configuration.");
  }
  declarationNames(names: readonly string[]): string[] {
    return names.filter(name => {
      const exposure = this.definitions.get(name)?.exposure;
      return exposure !== "hidden" && (exposure !== "codemode" && exposure !== "deferred" || this.revealed.has(name));
    });
  }
  resourceCatalog(): Array<Omit<SessionCapabilityItem, "enabled" | "activeToolNames">> {
    return [...this.states.values()].filter(server => server.resources).map(server => ({
      id: nativeMcpResourceCapabilityId(server.name), label: `MCP resources · ${server.name}`,
      description: `Allow resource listings and reads from ${server.name}. Resource helper tools must also be enabled.`,
      kind: "extension", toolNames: [], available: server.exposure !== "hidden" && !["disabled", "approval-required", "closed"].includes(server.state),
    }));
  }
  private configRevision(config: ReturnType<typeof loadNativeMcpConfig>): string {
    return createHash("sha256").update(JSON.stringify({
      servers: config.servers.filter(entry => entry.scope !== "extension").map(entry =>
        nativeMcpApprovalIdentity(this.cwd, entry.name, entry.source, entry.config)).sort(),
      errors: [...config.errors].sort(), autoEnableCodemode: config.autoEnableCodemode ?? true,
    })).digest("hex");
  }
  private reloadRequired(): boolean {
    if (!this.nativeStarted || this.loadedConfigRevision === undefined) return false;
    try {
      const preferences = readNativeMcpPreferences(this.agentDir);
      return preferences.enabled !== this.loadedEnabled
        || this.configRevision(loadNativeMcpConfig(this.agentDir, this.cwd, this.projectTrusted)) !== this.loadedConfigRevision
        || [...this.loadedRegisteredApprovals].some(([identity, approved]) => preferences.approvedRegistered.includes(identity) !== approved);
    } catch { return true; }
  }
  snapshot(): { reloadRequired: boolean; enabled: boolean; projectTrusted: boolean; owner: "native" | "replacement"; servers: NativeMcpServerState[] } {
    const preferences = readNativeMcpPreferences(this.agentDir);
    return { reloadRequired: this.reloadRequired(), enabled: preferences.enabled, projectTrusted: this.projectTrusted,
      owner: this.nativeStarted ? "native" : "replacement",
      servers: [...this.states.values()].map(server => ({ ...server, configurationCurrent: this.configurationIsCurrent(server.name), connectionAuthorized: this.isServerAuthorized(server.name),
        ...(server.scope === "extension" ? { approvalRequired: !preferences.approvedRegistered.includes(this.registeredApprovals.get(server.name) ?? "") } : {}),
        owner: this.nativeStarted ? "native" : "replacement", tools: server.tools.map(tool => ({ ...tool })) })) };
  }
  approveRegistered(name: string, approved: boolean): void {
    const identity = this.registeredApprovals.get(name);
    if (!identity) throw new Error("Registered MCP server not found");
    const preferences = readNativeMcpPreferences(this.agentDir);
    preferences.approvedRegistered = [...new Set(preferences.approvedRegistered.filter(id => id !== identity).concat(approved ? [identity] : []))];
    writeNativeMcpPreferences(this.agentDir, preferences);
    this.announce();
  }
  private observeEntry(entry: NativeMcpEntry, enabled: boolean): void {
    this.entries.set(entry.name, entry);
    const config = entry.config;
    const previous = this.states.get(entry.name);
    const endpoint = "url" in config ? new URL(config.url).origin : config.command;
    this.states.set(entry.name, { name: entry.name, source: entry.source, scope: entry.scope ?? "extension",
      transport: "url" in config ? "http" : "stdio", endpoint, exposure: config.exposure ?? "codemode",
      state: !enabled || config.enabled === false ? "disabled" : previous?.state ?? "configured",
      tools: previous?.tools ?? [], resources: previous?.resources ?? false, owner: "native" });
    const values = [...Object.values("url" in config ? config.headers ?? {} : config.env ?? {}), ...("url" in config && config.oauth?.clientSecret ? [config.oauth.clientSecret] : [])];
    if ("url" in config) {
      const url = new URL(config.url);
      this.rememberSecret(config.url);
      if (url.search) this.rememberSecret(url.search);
      for (const [key, value] of url.searchParams) if (/token|key|secret|credential|auth|signature|password/i.test(key)) this.rememberSecret(value);
    }
    for (const value of values) {
      this.rememberSecret(value);
      try { this.rememberSecret(environmentValue(value)); } catch { /* no command evaluation */ }
    }
  }
  private rememberSecret(value: string): void {
    if (!value) return;
    this.secrets.add(value);
    // A server may echo the token without the configured Authorization scheme.
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer) this.secrets.add(bearer[1].trim());
  }
  private redact(message: string): string {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) if (secret.length >= 3) {
      for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) message = message.split(form).join("[redacted]");
    }
    return message;
  }
  private sanitize<T>(value: T): T {
    const seen = new WeakMap<object, object>();
    const copy = (input: unknown): unknown => {
      if (typeof input === "string") return this.redact(input);
      if (!input || typeof input !== "object") return input;
      const existing = seen.get(input); if (existing) return existing;
      const output = Array.isArray(input) ? [] : Object.create(Object.getPrototypeOf(input));
      seen.set(input, output);
      // Preserve public error prototypes/status/code for upstream auth/retry,
      // but never retain an original cause, body, details or stack reference.
      for (const key of Reflect.ownKeys(input)) {
        if (Array.isArray(input) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if ("value" in descriptor) Object.defineProperty(output, typeof key === "string" ? this.redact(key) : key, { ...descriptor, value: copy(descriptor.value) });
      }
      return output;
    };
    return copy(value) as T;
  }
  private safeError(error: unknown): Error {
    return error instanceof Error ? this.sanitize(error) : new Error(typeof error === "string" ? this.redact(error) : "Native MCP operation failed");
  }
  private context<T extends ExtensionContext>(ctx: T): T {
    return new Proxy(ctx, { get: (target, key) => {
      if (key === "tools" && "tools" in target) return (target as unknown as ExtensionToolContext).tools.filter(tool => this.isAllowed(tool.name, RESOURCE_TOOLS.has(tool.name) ? { server: [...this.states.values()].find(server => server.resources && this.resourcePermission(server.name))?.name } : undefined));
      if (key === "ui") return { ...target.ui, notify: (message: string, type?: "info" | "warning" | "error") => target.ui.notify(type === "error" || message.startsWith("MCP servers need attention:") ? "Native MCP operation failed. Check the connection status and configuration." : this.redact(message), type) };
      return Reflect.get(target, key);
    } });
  }
  private api(pi: ExtensionAPI, kind: "mcp" | "codemode" | "search"): ExtensionAPI {
    const api: ExtensionAPI = { ...pi,
      getAllTools: () => pi.getAllTools().filter(tool => this.canDiscover(tool.name)),
      setActiveTools: names => {
        for (const name of names) if (this.permission(name)) this.revealed.add(name);
        pi.setActiveTools(names.filter(name => this.permission(name) && this.isAvailable(name)));
        this.announce();
      },
      getMcpServers: () => {
        const preferences = readNativeMcpPreferences(this.agentDir);
        const claimed = new Map([...this.entries.values()].filter(entry => entry.scope !== "extension").map(entry => [entry.name.replace(/-/g, "_"), entry.name]));
        return pi.getMcpServers().filter(server => {
          try { validateNativeMcpConfig(server.config, "global"); } catch { return false; }
          const namespace = server.name.replace(/-/g, "_");
          if (claimed.has(namespace) && claimed.get(namespace) !== server.name) return false;
          claimed.set(namespace, server.name);
          const source = server.extensionPath;
          const identity = nativeMcpApprovalIdentity(this.cwd, server.name, source, server.config);
          this.registeredApprovals.set(server.name, identity);
          this.loadedRegisteredApprovals.set(identity, preferences.approvedRegistered.includes(identity));
          const approved = preferences.enabled && preferences.approvedRegistered.includes(identity);
          if (!this.entries.has(server.name) || this.entries.get(server.name)?.scope === "extension") {
            this.observeEntry({ name: server.name, source, scope: "extension", config: server.config }, approved);
            if (!approved) this.states.get(server.name)!.state = "approval-required";
          }
          return approved;
        });
      },
      registerTool: definition => {
        const exposure = definition.exposure ?? "direct";
        const server = definition.namespace?.name.startsWith("mcp__")
          ? [...this.states.keys()].find(name => `mcp__${name.replace(/[^\w]/g, "_")}` === definition.namespace?.name) : undefined;
        this.definitions.set(definition.name, { exposure, server });
        if (server) {
          const state = this.states.get(server)!;
          state.tools = [...state.tools.filter(tool => tool.name !== definition.name), { name: definition.name, exposure }];
        }
        const original = definition;
        const wrapped = { ...definition, defaultActive: false,
          ...(original.prepareLoadout ? { prepareLoadout: (loadout: Parameters<NonNullable<typeof original.prepareLoadout>>[0]) => original.prepareLoadout!({ ...loadout,
            callable: loadout.callable.filter(tool => this.canDiscover(tool.name)) }) } : {}),
          execute: async (...[id, input, signal, update, ctx]: Parameters<typeof original.execute>) => {
            if (!this.isAllowed(original.name, input as Record<string, unknown>)) throw new Error("This tool is disabled by the Piora session capability policy.");
            try { return this.sanitize(await original.execute(id, input, signal, update ? value => update(this.sanitize(value)) : undefined, this.context(ctx))); }
            catch (error) { throw this.safeError(error); }
          },
        } as typeof definition;
        pi.registerTool(wrapped);
        this.announce();
      },
    };
    // Only the retained replaceable factory's handlers run. A legacy adapter
    // owning /mcp replaces the native factory before any server connects.
    api.on = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      return Reflect.apply(pi.on, pi, [event, async (payload: unknown, ctx: ExtensionContext) => {
        if (kind === "mcp" && event === "session_start") { this.nativeStarted = true; this.shuttingDown = false; }
        if (kind === "mcp" && event === "session_shutdown") { this.shuttingDown = true; this.nativeStarted = false; }
        try { return await handler(payload, this.context(ctx)); } catch { throw new Error("Native MCP extension operation failed"); }
      }]);
    }) as ExtensionAPI["on"];
    const registerCommand = api.registerCommand;
    api.registerCommand = (name, options) => registerCommand(name, { ...options,
      handler: async (args, ctx) => { try {
        if (kind === "mcp" && name === "mcp") {
          const [action, server] = args.trim().split(/\s+/);
          if (action === "login" || action === "reconnect") {
            if (!server) throw new Error("Specify an authorized MCP server");
            this.assertServerAuthorized(server);
          }
        }
        return await options.handler(args, this.context(ctx) as typeof ctx);
      } catch { throw new Error("Native MCP command failed. Check connection status, authorization and sign-in requirements."); } } });
    return api;
  }

  private transport(entry: NativeMcpEntry, cwd: string, auth: Parameters<NonNullable<NativeMcpOptions["createTransport"]>>[2]): McpTransport {
    const config = entry.config;
    if ("url" in config) return new StreamableHttpTransport({ url: config.url,
      headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, environmentValue(value)])), authProvider: auth,
      fetch: (input, init) => {
        const cancellation = init?.method === "POST" && typeof init.body === "string" && (() => { try { return JSON.parse(init.body).method === "notifications/cancelled"; } catch { return false; } })();
        if (init?.method !== "DELETE" && !cancellation) this.assertServerAuthorized(entry.name);
        return globalThis.fetch(input, init);
      } });
    return new StdioTransport({ command: expandHome(config.command), args: config.args?.map(expandHome),
      cwd: resolve(cwd, expandHome(config.cwd ?? ".")), env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, environmentValue(value)])), stderr: "pipe" });
  }
  private observeTransport(entry: NativeMcpEntry, transport: McpTransport): McpTransport {
    if (!this.states.has(entry.name)) this.observeEntry(entry, true);
    const state = this.states.get(entry.name)!;
    const methods = new Map<string | number, string>();
    const onMessage = transport.onMessage.bind(transport), onError = transport.onError.bind(transport);
    // Clean before conversion/truncation can save output to disk or deliver it
    // to the MCP client, tool pipeline, progress listeners and codemode worker.
    transport.onMessage = listener => onMessage(message => listener({ ...message,
      ...("result" in message ? { result: this.sanitize(message.result) } : {}),
      ...("error" in message ? { error: this.sanitize(message.error) } : {}),
      ...("params" in message ? { params: this.sanitize(message.params) } : {}),
    }));
    transport.onError = listener => onError(error => listener(this.safeError(error)));
    transport.onMessage(message => {
      if ("id" in message && "error" in message && methods.get(message.id!) === "tools/list") { state.state = "failed"; this.announce(); }
      if ("id" in message && "result" in message && methods.get(message.id!) === "tools/list") { state.state = "connected"; this.announce(); }
      if ("result" in message && message.result && typeof message.result === "object" && "protocolVersion" in message.result) {
        const result = message.result as { capabilities?: { resources?: unknown; tools?: unknown } };
        state.state = result.capabilities?.tools ? "connecting" : "connected";
        state.resources = !!result.capabilities?.resources;
        this.announce();
      }
      if ("id" in message && ("result" in message || "error" in message)) methods.delete(message.id!);
    });
    transport.onClose(() => { if (!["needs-auth", "failed"].includes(state.state)) state.state = this.shuttingDown ? "closed" : "disconnected"; this.announce(); });
    transport.onError(() => { state.state = "failed"; this.announce(); });
    const start = transport.start.bind(transport), send = transport.send.bind(transport), close = transport.close.bind(transport);
    transport.start = async () => { this.assertServerAuthorized(entry.name); state.state = "connecting"; this.announce(); try { await start(); } catch (error) { state.state = "failed"; this.announce(); throw this.safeError(error); } };
    transport.send = async message => { if (!("method" in message && message.method === "notifications/cancelled")) this.assertServerAuthorized(entry.name); if ("id" in message && "method" in message) methods.set(message.id, message.method); try { await send(message); } catch (error) {
      state.state = /Auth|Unauthorized|AuthorizationRequired/.test(error instanceof Error ? error.name : "") ? "needs-auth" : "failed";
      this.announce(); throw this.safeError(error);
    } };
    transport.close = async () => { try { await close(); } catch (error) { throw this.safeError(error); } if (!["needs-auth", "failed"].includes(state.state)) state.state = this.shuttingDown ? "closed" : "disconnected"; this.announce(); };
    return transport;
  }
}

const registryKey = Symbol.for("piora.native-mcp.controllers");
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: WeakMap<object, NativeMcpController> };
const controls = globalRegistry[registryKey] ??= new WeakMap<object, NativeMcpController>();
export const getNativeMcpController = (services: object) => controls.get(services);
export const setNativeMcpController = (services: object, control: NativeMcpController) => controls.set(services, control);
