import { NextResponse } from "next/server";
import { acquireDesktopUpdateLease, releaseDesktopUpdateLease } from "@/lib/prompt-run-registry";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { hasJsonContentType } from "@/lib/request-security";
import { requireHarmonyDesktopAccess } from "../../harmony/_shared";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireHarmonyDesktopAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  const input = await request.json().catch(() => null) as { action?: string; token?: string } | null;
  if (input?.action === "release" && typeof input.token === "string") {
    releaseDesktopUpdateLease(input.token);
    return NextResponse.json({ released: true });
  }
  if (input?.action !== "acquire") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  // No await between the runtime snapshot and the fence: background prompts
  // cannot start in the gap after Electron's preceding HTTP idle check.
  const token = getRunningRpcSessionIds().length === 0 ? acquireDesktopUpdateLease() : undefined;
  return NextResponse.json(token ? { token } : { busy: true }, { status: token ? 200 : 409, headers: { "Cache-Control": "no-store" } });
}
