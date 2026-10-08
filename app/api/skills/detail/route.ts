import { NextResponse } from "next/server";
import { apiError, body, requiredString } from "@/lib/skill-sources/api";
import { remoteSkillDetail } from "@/lib/skill-sources/catalog";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  try {
    const data = await body(req);
    return NextResponse.json({ detail: await remoteSkillDetail(requiredString(data.sourceId, "sourceId"), requiredString(data.skillId, "skillId"), typeof data.version === "string" ? data.version : undefined) });
  } catch (error) { return apiError(error); }
}
