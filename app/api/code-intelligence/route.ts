import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { codeProjectFor, runCodeQuery, supportsCodeIntelligence, type CodeAction, type CodeQuery } from "@/lib/code-intelligence";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ACTIONS = new Set<CodeAction>(["sync", "close", "definition", "completion", "hover", "status"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, MAX_BODY_BYTES) as Partial<CodeQuery>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    if (!body.action || !ACTIONS.has(body.action) || typeof body.filePath !== "string" || body.filePath.length > 4096 || !supportsCodeIntelligence(body.filePath)) {
      return NextResponse.json({ error: "Unsupported file or action" }, { status: 400 });
    }
    if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 4096)) return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
    if (body.content !== undefined && (typeof body.content !== "string" || body.content.length > 1024 * 1024)) return NextResponse.json({ error: "File is too large" }, { status: 413 });
    if (body.version !== undefined && (!Number.isSafeInteger(body.version) || body.version < 1)) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
    if (body.offset !== undefined && (!Number.isSafeInteger(body.offset) || body.offset < 0)) return NextResponse.json({ error: "Invalid position" }, { status: 400 });
    const roots = await getAllowedFileRoots();
    const filePath = resolve(body.filePath);
    if (!isFilePathAllowed(filePath, roots) || !isExistingFilePathAllowed(filePath, roots)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const cwd = body.cwd ? resolve(body.cwd) : undefined;
    if (cwd && (!isFilePathAllowed(cwd, roots) || !isExistingFilePathAllowed(cwd, roots))) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const projectRoot = codeProjectFor(filePath, cwd).root;
    if (!isExistingFilePathAllowed(projectRoot, roots)) return NextResponse.json({ error: "Project access denied" }, { status: 403 });
    const result = await runCodeQuery({ ...body, filePath, cwd } as CodeQuery);
    if (result.definitions) result.definitions = result.definitions.filter((target) => isExistingFilePathAllowed(target.filePath, roots));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof JsonBodyTooLargeError ? 413 : error instanceof InvalidJsonBodyError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
