import { NextResponse } from "next/server";
import { applyNetworkProxySettings } from "@/lib/http-dispatcher";
import {
  readNetworkProxySettings,
  writeNetworkProxySettings,
} from "@/lib/network-proxy";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { isApiRequestAllowed } from "@/lib/request-security";
import { applyDesktopProxySettings } from "@/lib/desktop-network-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  return json(readNetworkProxySettings());
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  try {
    const body = await parseJsonWithinLimit(request, 8_192);
    const settings = writeNetworkProxySettings(body);
    applyNetworkProxySettings(settings);
    await applyDesktopProxySettings(settings);
    return json(settings);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to save proxy settings" }, 400);
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  try {
    const startedAt = Date.now();
    const response = await fetch("https://api.github.com/meta", {
      cache: "no-store",
      headers: { accept: "application/vnd.github+json", "user-agent": "Piora-network-test" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    await response.body?.cancel();
    return json({ ok: true, latencyMs: Date.now() - startedAt });
  } catch (error) {
    const cause = error && typeof error === "object" && "cause" in error
      ? (error as { cause?: { code?: unknown } }).cause
      : undefined;
    const detail = typeof cause?.code === "string"
      ? cause.code
      : error instanceof Error ? error.message : "Connection failed";
    return json({ ok: false, error: detail }, 502);
  }
}
