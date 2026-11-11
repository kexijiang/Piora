import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPermissionMode } from "@/lib/tool-permission-policy";
import { readDefaultToolPermission, writeDefaultToolPermission } from "@/lib/tool-permission-store";

export async function GET() {
  return NextResponse.json({ mode: readDefaultToolPermission(getAgentDir()) });
}
export async function PUT(request: Request) {
  const body = await request.json();
  if (!isPermissionMode(body.mode)) return NextResponse.json({ error: "Invalid permission mode" }, { status: 400 });
  writeDefaultToolPermission(body.mode, getAgentDir());
  return NextResponse.json({ mode: body.mode });
}
