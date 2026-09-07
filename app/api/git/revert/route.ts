import { invalidateGitStatusCache } from "@/lib/git-status-cache";
import { NextRequest, NextResponse } from "next/server";
import { revertGitPaths } from "@/lib/git-write";
import { gitErrorResponse, readGitPathsBody } from "../_shared";

export async function POST(request: NextRequest) {
  try {
    const { cwd, paths, raw } = await readGitPathsBody(request);
    if (typeof raw.diffHash !== "string") return NextResponse.json({ error: "diffHash is required" }, { status: 400 });
    await revertGitPaths(cwd, paths, raw.diffHash, typeof raw.patch === "string" ? raw.patch : undefined);
    return NextResponse.json({ ok: true });
  } catch (error) { const result = gitErrorResponse(error); return NextResponse.json(result, { status: result.status }); } finally { invalidateGitStatusCache(); }
}
