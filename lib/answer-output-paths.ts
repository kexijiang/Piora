import { createHash } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Host-owned sidecar locations; no experimental module is loaded for cleanup. */
export function answerOutputStatePath(kind: "intelligent-ui" | "mini-app", sessionId: string, root = getAgentDir()): string {
  if (kind === "mini-app") return join(root, "piora", kind, `state-${createHash("sha256").update(sessionId).digest("hex")}.json`);
  return join(root, "piora", kind, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function answerOutputMiniAppPublicationPath(sessionId: string, root = getAgentDir()): string {
  return join(root, "piora", "mini-app", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function answerOutputGenerationPath(sessionId: string, root = getAgentDir()): string {
  return join(root, "piora", "intelligent-ui", `generation-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function removeAnswerOutputState(sessionId: string): void {
  rmSync(answerOutputStatePath("intelligent-ui", sessionId), { force: true });
  rmSync(answerOutputGenerationPath(sessionId), { force: true });
  rmSync(answerOutputStatePath("mini-app", sessionId), { force: true });
  rmSync(answerOutputMiniAppPublicationPath(sessionId), { force: true });
}
