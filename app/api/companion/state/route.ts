import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import {
  migrateCompanionPreferences,
  normalizeCompanionRuntimeState,
  readCompanionRuntimeState,
  writeCompanionRuntimeState,
} from "@/lib/companion-runtime";
import { normalizeCompanionPreferences } from "@/lib/companion-store";
import { scheduleTodoReminders } from "@/lib/companion-todo-reminder";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  return NextResponse.json(readCompanionRuntimeState());
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, MAX_REQUEST_BYTES) as { state?: unknown; legacyPreferences?: unknown };
    if (body.legacyPreferences) {
      return NextResponse.json(migrateCompanionPreferences(normalizeCompanionPreferences(body.legacyPreferences)));
    }
    if (!body.state) return NextResponse.json({ error: "Companion state is required" }, { status: 400 });
    const current = readCompanionRuntimeState();
    const requested = normalizeCompanionRuntimeState(body.state);
    return NextResponse.json(writeCompanionRuntimeState({
      ...requested,
      todos: scheduleTodoReminders(requested.todos, current.todos),
      migratedFromLocalStorage: current.migratedFromLocalStorage,
      mind: current.mind,
    }));
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
