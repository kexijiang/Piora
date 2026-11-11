// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
import { readLogSearchHistory, updateLogSearchHistory, type LogSearchKind } from "@/lib/harmony/log-search-history";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

const KINDS = new Set<LogSearchKind>(["find", "filter"]);

function requiredKind(value: unknown): LogSearchKind {
  if (typeof value !== "string" || !KINDS.has(value as LogSearchKind)) throw new HarmonyError("INVALID_ARGUMENT", "kind must be find or filter");
  return value as LogSearchKind;
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new HarmonyError("INVALID_ARGUMENT", `${name} must be a boolean`);
  return value;
}

function requiredQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HarmonyError("INVALID_ARGUMENT", "query is required");
  if (value.length > 400) throw new HarmonyError("INVALID_ARGUMENT", "query is too long");
  return value.trim();
}

/** Shared candidate list for the live and the session-log views. */
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    return noStoreJson({ history: readLogSearchHistory() });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 4096) as Record<string, unknown>;
    const kind = requiredKind(body?.kind);
    const action = body?.action;
    if (action === "clear") return noStoreJson({ history: updateLogSearchHistory({ kind, action: "clear" }) });
    if (action !== "record" && action !== "remove") throw new HarmonyError("INVALID_ARGUMENT", "Unsupported history action");
    const query = requiredQuery(body.query);
    const regex = optionalBoolean(body.regex, "regex");
    const caseSensitive = optionalBoolean(body.caseSensitive, "caseSensitive");
    return noStoreJson({ history: updateLogSearchHistory({ kind, action, query, regex, caseSensitive }) });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
