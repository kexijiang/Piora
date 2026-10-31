import { latestTaskTiming } from "@/lib/task-timing";
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { SessionControlStore } from "@/lib/session-control-store";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolvePromptMaterialReferences } from "@/lib/prompt-materials";
import { commandOperationView } from "@/lib/chat-command-events";

/** Read the durable send archive even when a prompt never reached model history. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = new SessionControlStore();
  const commands = store.loadCommands(id).filter((command) => command.source === "ui");
  if (!commands.length && !getRpcSession(id) && !await resolveSessionPath(id)) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "operations") {
    const operations = commands.filter(command => command.operation).reverse();
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const tracked = new Set(url.searchParams.getAll("trackedCommandId").slice(0, 100));
    const recovered = new Set(url.searchParams.getAll("trackedPromptId").slice(0, 100));
    const items = new Map(operations.slice(offset, offset + 50).map(command => [command.commandId, command]));
    // Include all waiting input, plus terminal receipts for this renderer's tracked
    // inputs. Do not replay historical ordinary completions on every page mount.
    for (const command of commands) if (!["completed", "failed", "cancelled", "expired", "interrupted"].includes(command.status) || tracked.has(command.commandId) || recovered.has(command.idempotencyKey)) items.set(command.commandId, command);
    const taskTimings = commands.flatMap(command => command.taskTiming ? [{ idempotencyKey: command.idempotencyKey, taskTiming: command.taskTiming }] : []);
    return NextResponse.json({ taskTiming: latestTaskTiming(commands), taskTimings, items: [...items.values()].map(commandOperationView), nextOffset: offset + 50 < operations.length ? offset + 50 : null }, { headers: { "Cache-Control": "no-store" } });
  }
  const commandId = url.searchParams.get("commandId");
  if (commandId) {
    const command = commands.find((item) => item.commandId === commandId);
    if (!command) return NextResponse.json({ error: "发送记录不存在" }, { status: 404 });
    try {
      const files = command.materials?.length ? resolvePromptMaterialReferences(command.materials).map((file) => ({ name: file.name, size: file.byteLength, text: readFileSync(file.path, "utf8"), kind: "file" as const })) : [];
      return NextResponse.json({ value: command.operation?.rawText ?? command.content, images: (command.images ?? []).map(({ data, mimeType }) => ({ data, mimeType })), files: [...files, ...(command.localFiles ?? []).map(file => ({ ...file, text: null }))], ...(command.operation?.inputOptions ? { commandInput: command.operation.inputOptions } : command.inputMode ? { commandInput: { inputMode: command.inputMode } } : {}) }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "附件无法完整读取，未恢复残缺内容。原发送记录仍保留。" }, { status: 409 });
    }
  }
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const recent = [...commands].reverse();
  return NextResponse.json({ items: recent.slice(offset, offset + 50).map((item) => ({ id: item.commandId, timestamp: item.acceptedAt, preview: item.content.slice(0, 180), attachments: (item.images?.length ?? 0) + (item.materials?.length ?? 0) })), nextOffset: offset + 50 < recent.length ? offset + 50 : null }, { headers: { "Cache-Control": "no-store" } });
}
