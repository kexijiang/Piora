import { invalidateGitStatusCache } from "@/lib/git-status-cache";
import { NextRequest, NextResponse } from "next/server";
import { stageGitPaths } from "@/lib/git-write";
import { gitErrorResponse, readGitPathsBody } from "../_shared";

export async function POST(request: NextRequest) {
  try { const { cwd, paths, raw } = await readGitPathsBody(request); await stageGitPaths(cwd, paths, typeof raw.patch === "string" ? raw.patch : undefined, typeof raw.diffHash === "string" ? raw.diffHash : undefined); return NextResponse.json({ ok: true }); }
  catch (error) { const result = gitErrorResponse(error); return NextResponse.json(result, { status: result.status }); } finally { invalidateGitStatusCache(); }
}
