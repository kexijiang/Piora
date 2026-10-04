import { NextResponse } from "next/server";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRpcSession, invalidateServicesCache } from "@/lib/rpc-manager";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  loadNativeMcpConfig, readNativeMcpPreferences, writeNativeMcpPreferences,
  updateNativeMcpServer, NATIVE_MCP_EXPOSURES, type NativeMcpExposure,
} from "@/lib/native-mcp-config";

export const dynamic = "force-dynamic";

async function context(cwd: string, sessionId?: string) {
  if (!cwd || !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  const session = sessionId ? getRpcSession(sessionId) : undefined;
  if (sessionId && (!session || resolve(session.inner.sessionManager.getCwd()) !== resolve(cwd))) throw new Error("Session does not belong to this workspace");
  const agentDir = getAgentDir();
  const live = session?.nativeMcp?.snapshot();
  const projectTrusted = live?.projectTrusted ?? new ProjectTrustStore(agentDir).get(cwd) === true;
  return { cwd, agentDir, session, projectTrusted, live };
}
type Context = Awaited<ReturnType<typeof context>>;
function view(ctx: Context) {
  const config = loadNativeMcpConfig(ctx.agentDir, ctx.cwd, ctx.projectTrusted);
  const live = ctx.session?.nativeMcp?.snapshot();
  const liveStates = new Map(live?.servers.map(server => [server.name, server]) ?? []);
  return { enabled: readNativeMcpPreferences(ctx.agentDir).enabled, projectTrusted: ctx.projectTrusted,
    owner: live?.owner ?? "not-started", live: !!live,
    diagnostics: config.errors,
    servers: [...config.servers.map(entry => {
      const state = liveStates.get(entry.name);
      return { name: entry.name, source: entry.source, scope: entry.scope,
        override: entry.override, enabled: entry.config.enabled !== false,
        exposure: entry.config.exposure ?? "codemode", transport: "url" in entry.config ? "http" : "stdio",
        endpoint: "url" in entry.config ? new URL(entry.config.url).origin : entry.config.command,
        state: state?.state ?? (entry.config.enabled === false ? "disabled" : "configured"),
        liveEndpoint: state?.endpoint, configurationCurrent: state?.configurationCurrent,
        connectionAuthorized: state?.connectionAuthorized ?? false,
        tools: state?.tools ?? [], resources: state?.resources ?? false, owner: live?.owner ?? "not-started" };
    }), ...(live?.servers.filter(server => server.scope === "extension" && !config.servers.some(entry => entry.name === server.name)) ?? [])],
    reloadRequired: live?.reloadRequired ?? false,
  };
}
function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "MCP operation failed";
  return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const params = new URL(request.url).searchParams;
  try { return NextResponse.json(view(await context(params.get("cwd") ?? "", params.get("sessionId") ?? undefined))); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("MCP request is too large");
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("Invalid MCP request JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid MCP request");
    const ctx = await context(typeof body.cwd === "string" ? body.cwd : "", typeof body.sessionId === "string" ? body.sessionId : undefined);
    if (body.action === "integration" && typeof body.enabled === "boolean") {
      writeNativeMcpPreferences(ctx.agentDir, { ...readNativeMcpPreferences(ctx.agentDir), enabled: body.enabled });
    } else if (body.action === "approve-registered" && typeof body.name === "string" && typeof body.enabled === "boolean") {
      if (!ctx.session?.nativeMcp) throw new Error("Open a normal session to approve a registered server");
      ctx.session.nativeMcp.approveRegistered(body.name, body.enabled);
    } else if (body.action === "server" && typeof body.name === "string" && (body.scope === "global" || body.scope === "project")) {
      if (body.exposure !== undefined && !NATIVE_MCP_EXPOSURES.includes(body.exposure as NativeMcpExposure)) throw new Error("Unsupported MCP exposure");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean" || body.remove !== undefined && typeof body.remove !== "boolean") throw new Error("Invalid MCP operation");
      updateNativeMcpServer(ctx.agentDir, ctx.cwd, ctx.projectTrusted, { name: body.name, scope: body.scope,
        config: body.config, enabled: body.enabled as boolean | undefined, exposure: body.exposure as NativeMcpExposure | undefined, remove: body.remove as boolean | undefined });
    } else throw new Error("Invalid MCP operation");
    invalidateServicesCache();
    return NextResponse.json(view(ctx));
  } catch (error) { return errorResponse(error); }
}
