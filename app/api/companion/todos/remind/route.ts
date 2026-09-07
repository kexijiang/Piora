import { NextResponse } from "next/server";
import { readCompanionRuntimeState, writeCompanionRuntimeState } from "@/lib/companion-runtime";
import { remindDueTodo } from "@/lib/companion-todo-reminder";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    // Synchronous read/check/write prevents two pet windows from claiming the same reminder.
    const next = remindDueTodo(readCompanionRuntimeState());
    if (next) writeCompanionRuntimeState(next, "todo.reminder");
    return NextResponse.json({ reminded: Boolean(next) });
  } catch {
    return NextResponse.json({ error: "待办提醒暂时不可用。" }, { status: 500 });
  }
}
