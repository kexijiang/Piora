import { invalidateGitStatusCache } from "@/lib/git-status-cache";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { pushGit, validateGitWritePaths } from "@/lib/git-write";
import { gitErrorResponse } from "../_shared";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonWithinLimit(request, 64 * 1024) as Record<string, unknown>;
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    validateGitWritePaths(cwd, ["."], await getAllowedFileRoots());
    await pushGit(cwd);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const result = gitErrorResponse(error);
    return NextResponse.json(result, { status: result.status });
  } finally { invalidateGitStatusCache(); }
}
