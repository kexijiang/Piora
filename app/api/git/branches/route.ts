import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getGitBranches, switchGitBranch } from "@/lib/git-branches";
import { GitWriteError } from "@/lib/git-write";
import { invalidateGitStatusCache } from "@/lib/git-status-cache";

const MAX_BODY_BYTES = 16 * 1024;

async function validateCwd(value: unknown): Promise<string> {
  const cwd = typeof value === "string" ? value.trim() : "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) throw new GitWriteError("cwd must be an absolute path");
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) throw new GitWriteError("Access denied", 403, "access_denied");
  let stat: fs.Stats;
  try { stat = fs.statSync(cwd); }
  catch { throw new GitWriteError("Directory not found", 404, "directory_not_found"); }
  if (!stat.isDirectory()) throw new GitWriteError("Not a directory");
  return cwd;
}

function errorResponse(error: unknown) {
  if (error instanceof JsonBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
  if (error instanceof InvalidJsonBodyError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof GitWriteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const cwd = await validateCwd(request.nextUrl.searchParams.get("cwd"));
    return NextResponse.json(await getGitBranches(cwd));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GitWriteError("Request body must be an object");
    const record = body as Record<string, unknown>;
    const cwd = await validateCwd(record.cwd);
    if (typeof record.branch !== "string") throw new GitWriteError("branch must be a string");
    return NextResponse.json(await switchGitBranch(cwd, record.branch));
  } catch (error) { return errorResponse(error); }
  finally { invalidateGitStatusCache(); }
}
