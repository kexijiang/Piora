import { createHash } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Host-owned sidecar locations; no experimental module is loaded for cleanup. */
export function answerOutputStatePath(kind: "intelligent-ui", sessionId: string, root = getAgentDir()): string {
  return join(root, "piora", kind, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function removeAnswerOutputState(sessionId: string): void {
  rmSync(answerOutputStatePath("intelligent-ui", sessionId), { force: true });
}
