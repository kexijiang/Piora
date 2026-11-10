import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Local Piora account identity, never an Agent binding or a verified employee id. */
export function localRoomUserAuthor() {
  const root = join(getAgentDir(), "piora");
  const file = join(root, "room-local-user.json");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { writeFileSync(file, JSON.stringify({ id: `local-user:${randomUUID()}` }), { flag: "wx", flush: true, mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const saved = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown };
  if (typeof saved.id !== "string" || !/^local-user:[0-9a-f-]{36}$/i.test(saved.id)) throw new Error("本机群聊用户身份文件无效。");
  let account = "local user";
  try { account = userInfo().username; } catch { /* The stable id is still available. */ }
  return { authorKind: "user" as const, authorId: saved.id, authorName: account, authorIdentitySource: "local_account" as const };
}
