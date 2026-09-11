import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { acquireSessionMutation } from "@/lib/session-mutation";
import { resolveSessionPath, invalidateSessionListCache } from "@/lib/session-reader";
import { getRpcSession, stopRpcSessionsForFileMutation } from "@/lib/rpc-manager";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { deleteSessionMessageEntries } from "@/lib/session-message-delete";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  let release: (() => void) | undefined;
  try {
    release = acquireSessionMutation([id]);
    if (getRpcSession(id)?.isRunning()) return NextResponse.json({ error: "任务正在运行，请停止或等待完成后再删除消息。" }, { status: 409 });
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
    await stopRpcSessionsForFileMutation([id], { rejectRunning: true });
    const entries = readFileSync(filePath, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) as FileEntry[];
    if (entries[0]?.type !== "session" || entries[0].id !== id) throw new Error("会话文件不匹配，未删除消息。");
    const result = deleteSessionMessageEntries(entries, entryId);
    writePrivateFileAtomicSync(filePath, result.entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    invalidateSessionListCache();
    return NextResponse.json({ success: true, deletedIds: result.deletedIds });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally { release?.(); }
}
