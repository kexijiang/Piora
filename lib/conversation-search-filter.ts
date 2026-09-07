import type { SessionFlags } from "./session-flags";
import type { SessionInfo } from "./types";

export function matchesConversationFilter(session: SessionInfo, flags: SessionFlags, archive: string, project?: string | null): boolean {
  const archived = flags[session.id]?.archived === true;
  if (archive === "active" && archived || archive === "archived" && !archived) return false;
  const key = session.projectless ? "__projectless__" : session.projectRoot ?? session.cwd;
  return !project || key === project;
}
