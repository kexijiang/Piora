import { existsSync } from "node:fs";
import { answerOutputStatePath, answerOutputGenerationPath, answerOutputMiniAppPublicationPath } from "./answer-output-paths";
import type { ReadonlySessionManager } from "./session-readonly-manager";
import type { AnswerOutputCopyOptions, AnswerOutputPersistenceAdapter } from "./answer-output-persistence";

/** Persistence adapters are separate from feature renderers and agent tools. */
const adapters = [{
  kind: "intelligent-ui",
  hasState: (sessionId: string) => existsSync(answerOutputStatePath("intelligent-ui", sessionId)) || existsSync(answerOutputGenerationPath(sessionId)),
  load: async (): Promise<AnswerOutputPersistenceAdapter> => (await import("./intelligent-ui/answer-output-adapter")).persistence,
}, {
  kind: "mini-app",
  hasState: (sessionId: string) => existsSync(answerOutputStatePath("mini-app", sessionId)) || existsSync(answerOutputMiniAppPublicationPath(sessionId)),
  load: async (): Promise<AnswerOutputPersistenceAdapter> => (await import("./mini-app/answer-output-adapter")).persistence,
}];
export async function copyAnswerOutputState(source: string, target: string, retainedEntryIds: readonly string[], options: AnswerOutputCopyOptions = {}) {
  for (const adapter of adapters) {
    if (adapter.hasState(source) || options.sourceFile && options.targetFile) {
      await (await adapter.load()).copy(source, target, retainedEntryIds, options);
    }
  }
}
export async function readAnswerOutputSavedSnapshot(kind: string, sessionId: string, sessionFile: string, toolCallId: string): Promise<string> {
  const adapter = adapters.find(item => item.kind === kind);
  if (!adapter) throw new Error("Unknown answer output");
  return (await adapter.load()).readSnapshot(sessionId, sessionFile, toolCallId);
}
export async function answerOutputExportAppendix(sessionId: string, sessionFile: string, snapshot?: ReadonlySessionManager): Promise<string> {
  const active = adapters.filter(adapter => adapter.hasState(sessionId));
  if (!active.length) return "";
  const snapshots = (await Promise.all(active.map(async adapter => (await adapter.load()).snapshots(sessionId, sessionFile, snapshot)))).flat();
  if (!snapshots.length) return "";
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<section aria-label="Saved interactive parameters" style="padding:24px"><h2>Saved interactive parameters / 已保存的交互参数</h2><p>Current branch snapshot; interactive controls require Piora. / 当前分支快照，交互控件需在 Piora 中使用。</p>${snapshots.map(snapshot => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(snapshot)}</pre>`).join("")}</section>`;
}
