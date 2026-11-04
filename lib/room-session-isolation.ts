import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "./rpc-manager";
import { isolateRoomMemberSessions } from "./room-store";
import { persistLazySessionManager } from "./session-persistence";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { getTeamRunStore } from "./team-run-store";
import type { TeamAgentBinding } from "./team-types";

/** No model call and no transcript copy: room profiles, not private history, survive migration. */
export function ensureRoomSessionIsolation(roomId: string) {
  return isolateRoomMemberSessions(roomId, {
    isBusy: (room, member) => Boolean(getRpcSession(member.sessionId)?.isRunning())
      || getTeamRunStore().listTeamRuns(room.id, { includeTerminal: false, limit: 1 }).length > 0,
    create: (room, member) => {
      const receiptRoot = join(room.paths.root, ".session-isolation");
      mkdirSync(receiptRoot, { recursive: true });
      const receiptPath = join(receiptRoot, createHash("sha256").update(JSON.stringify([member.memberId, member.sessionId])).digest("hex") + ".json");
      // The store holds the room lock. Persist this receipt before changing any
      // task or binding so interrupted multi-file migration retries use one id.
      if (existsSync(receiptPath)) {
        const saved = JSON.parse(readFileSync(receiptPath, "utf8")) as { binding: TeamAgentBinding; file: string };
        if (!existsSync(saved.file)) throw new Error("迁移中的群聊会话文件缺失，请恢复文件后重试。");
        cacheSessionPath(saved.binding.sessionId, saved.file);
        return saved.binding;
      }
      const cwd = resolve(member.binding.cwd ?? room.projectRoot ?? room.workspace.path);
      const manager = SessionManager.create(cwd);
      manager.appendSessionInfo(`${room.name} · ${member.profile.name}`);
      const file = persistLazySessionManager(manager);
      if (!file) throw new Error("无法保存独立群聊会话。");
      cacheSessionPath(manager.getSessionId(), file);
      invalidateSessionListCache();
      // Ownership of an imported private worktree stays with its original chat.
      const binding: TeamAgentBinding = { sessionId: manager.getSessionId(), cwd,
        projectRoot: member.binding.projectRoot ?? room.projectRoot, managedByPiora: true,
        boundAt: Date.now(), status: "ready" };
      const temporary = `${receiptPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ binding, file }), { flush: true, mode: 0o600 });
      renameSync(temporary, receiptPath);
      return binding;
    },
  });
}
