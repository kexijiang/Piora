import { NextResponse } from "next/server";
import { getComputerControl } from "@/lib/computer-control";
import { hasJsonContentType } from "@/lib/request-security";
import { requireHarmonyDesktopAccess } from "../harmony/_shared";
import { setExtensionEnabled } from "@/lib/extension-config";
import { invalidateServicesCache } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = requireHarmonyDesktopAccess(request);
  if (denied) return denied;
  return NextResponse.json(getComputerControl().state(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  const denied = requireHarmonyDesktopAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  try {
    const input = await request.json() as { action?: unknown };
    const runtime = getComputerControl();
    if (input.action === "connect") {
      runtime.resume();
      await runtime.connect(request.signal);
      setExtensionEnabled("piora:computer", true);
      invalidateServicesCache();
    }
    else if (input.action === "stop") await runtime.stop();
    else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    return NextResponse.json(runtime.state(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ...getComputerControl().state(), error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
