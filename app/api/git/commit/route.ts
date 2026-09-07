import { invalidateGitStatusCache } from "@/lib/git-status-cache";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { commitGit, GitWriteError, validateGitWritePaths } from "@/lib/git-write";
import { gitErrorResponse } from "../_shared";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonWithinLimit(request, 256 * 1024) as Record<string, unknown>;
    const cwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";
    validateGitWritePaths(cwd, ["."], await getAllowedFileRoots());
    if (typeof body.message !== "string") throw new GitWriteError("message is required");
    if (body.amend !== undefined && typeof body.amend !== "boolean") throw new GitWriteError("amend must be boolean");
    if (body.includeUnstaged !== undefined && typeof body.includeUnstaged !== "boolean") throw new GitWriteError("includeUnstaged must be boolean");
    const sha = await commitGit(cwd, body.message, body.amend === true, body.includeUnstaged === true);
    return NextResponse.json({ ok: true, sha });
  } catch (error) { const result = gitErrorResponse(error); return NextResponse.json(result, { status: result.status }); } finally { invalidateGitStatusCache(); }
}
