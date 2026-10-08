import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { hasJsonContentType, isApiRequestAllowed } from "../request-security";
import { SkillSourceError } from "./types";

export function guard(request: Request) {
  if (!isApiRequestAllowed(request)) throw new SkillSourceError("request", "Untrusted API request", 403);
  if (request.method !== "GET" && !hasJsonContentType(request)) throw new SkillSourceError("request", "Content-Type must be application/json", 415);
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  guard(request);
  if (Number(request.headers.get("content-length")) > 32768) throw new SkillSourceError("size", "Request too large", 413);
  let data: unknown;
  try { const text = await request.text(); if (text.length > 32768) throw new Error(); data = JSON.parse(text); } catch { throw new SkillSourceError("invalid", "Invalid JSON request"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new SkillSourceError("invalid", "Expected an object");
  return data as Record<string, unknown>;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4096) throw new SkillSourceError("invalid", `${label} is required`);
  return value;
}
export async function allowedCwd(value: unknown, required = false): Promise<string | undefined> {
  if (value === undefined || value === null || value === "") { if (required) throw new SkillSourceError("cwd", "Project directory is required"); return undefined; }
  const cwd = requiredString(value, "cwd");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new SkillSourceError("access", "Access denied", 403);
  if (!statSync(cwd).isDirectory()) throw new SkillSourceError("cwd", "Project path must be a directory");
  return cwd;
}
export function apiError(error: unknown) {
  return NextResponse.json({ error: error instanceof SkillSourceError ? error.message : "Skill operation failed", code: error instanceof SkillSourceError ? error.code : "internal" }, { status: error instanceof SkillSourceError ? error.status : 500 });
}
