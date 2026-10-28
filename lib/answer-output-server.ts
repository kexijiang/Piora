import { existsSync } from "node:fs";
import { answerOutputStatePath } from "./answer-output-paths";

/** Persistence adapters are separate from feature renderers and agent tools. */
const adapters = [{
  hasState: (sessionId: string) => existsSync(answerOutputStatePath("intelligent-ui", sessionId)),
  load: () => import("./intelligent-ui/store"),
}];
export async function copyAnswerOutputState(source: string, target: string, retainedEntryIds: readonly string[]) {
  for (const adapter of adapters) {
    if (adapter.hasState(source)) (await adapter.load()).copyIntelligentUiState(source, target, retainedEntryIds);
  }
}
export async function answerOutputExportAppendix(sessionId: string, sessionFile: string): Promise<string> {
  const active = adapters.filter(adapter => adapter.hasState(sessionId));
  if (!active.length) return "";
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { getRpcSession } = await import("./rpc-manager");
  const branch = (getRpcSession(sessionId)?.inner.sessionManager ?? SessionManager.open(sessionFile)).getBranch();
  const snapshots = (await Promise.all(active.map(async adapter => (await adapter.load()).intelligentUiSnapshots(sessionId, branch)))).flat();
  if (!snapshots.length) return "";
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<section aria-label="Saved interactive parameters" style="padding:24px"><h2>Saved interactive parameters / 已保存的交互参数</h2><p>Current branch snapshot; interactive controls require Piora. / 当前分支快照，交互控件需在 Piora 中使用。</p>${snapshots.map(snapshot => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(snapshot)}</pre>`).join("")}</section>`;
}
