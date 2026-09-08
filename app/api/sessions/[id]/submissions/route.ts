import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { SessionControlStore } from "@/lib/session-control-store";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolvePromptMaterialReferences } from "@/lib/prompt-materials";

/** Read the durable send archive even when a prompt never reached model history. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = new SessionControlStore();
  const commands = store.loadCommands(id).filter((command) => command.source === "ui");
  if (!commands.length && !getRpcSession(id) && !await resolveSessionPath(id)) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  const url = new URL(request.url);
  const commandId = url.searchParams.get("commandId");
  if (commandId) {
    const command = commands.find((item) => item.commandId === commandId);
    if (!command) return NextResponse.json({ error: "发送记录不存在" }, { status: 404 });
    try {
      const files = command.materials?.length ? resolvePromptMaterialReferences(command.materials).map((file) => ({ name: file.name, size: file.byteLength, text: readFileSync(file.path, "utf8"), kind: "file" as const })) : [];
      return NextResponse.json({ value: command.content, images: (command.images ?? []).map(({ data, mimeType }) => ({ data, mimeType })), files }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "附件无法完整读取，未恢复残缺内容。原发送记录仍保留。" }, { status: 409 });
    }
  }
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const recent = [...commands].reverse();
  return NextResponse.json({ items: recent.slice(offset, offset + 50).map((item) => ({ id: item.commandId, timestamp: item.acceptedAt, preview: item.content.slice(0, 180), attachments: (item.images?.length ?? 0) + (item.materials?.length ?? 0) })), nextOffset: offset + 50 < recent.length ? offset + 50 : null }, { headers: { "Cache-Control": "no-store" } });
}
