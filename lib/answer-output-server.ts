import { existsSync } from "node:fs";
import { answerOutputStatePath, answerOutputGenerationPath } from "./answer-output-paths";
import type { ReadonlySessionManager } from "./session-readonly-manager";

/** Persistence adapters are separate from feature renderers and agent tools. */
const adapters = [{
  hasState: (sessionId: string) => existsSync(answerOutputStatePath("intelligent-ui", sessionId)),
  load: () => import("./intelligent-ui/store"),
}];
export async function copyAnswerOutputState(source: string, target: string, retainedEntryIds: readonly string[], options: { sourceFile?: string; targetFile?: string; sourceLeafId?: string | null } = {}) {
  let anchorMap: ReadonlyMap<string, string> | undefined;
  if (existsSync(answerOutputGenerationPath(source)) || options.sourceFile && options.targetFile) {
    if (!options.sourceFile || !options.targetFile) throw new Error("Generation inheritance requires the source and target session files");
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const { copyGenerationJournal } = await import("./intelligent-ui/generation-journal");
    anchorMap = (await copyGenerationJournal({ source, target, retainedEntryIds, sourceFile: options.sourceFile, targetFile: options.targetFile, sourceLeafId: options.sourceLeafId, root: getAgentDir(), includeLegacy: true })).anchorMap;
  }
  for (const adapter of adapters) {
    if (!anchorMap && adapter.hasState(source)) (await adapter.load()).copyIntelligentUiState(source, target, retainedEntryIds);
  }
}
export async function answerOutputExportAppendix(sessionId: string, sessionFile: string, snapshot?: ReadonlySessionManager): Promise<string> {
  if (!adapters.some(adapter => adapter.hasState(sessionId)) && !existsSync(answerOutputGenerationPath(sessionId))) return "";
  const { intelligentUiSessionReader } = await import("./intelligent-ui/session");
  const manager = snapshot ?? (await intelligentUiSessionReader(sessionId, sessionFile))();
  const { readUiSnapshots } = await import("./intelligent-ui/read-output");
  const snapshots = await readUiSnapshots(manager);
  if (!snapshots.length) return "";
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<section aria-label="Saved interactive parameters" style="padding:24px"><h2>Saved interactive parameters / 已保存的交互参数</h2><p>Current branch snapshot; interactive controls require Piora. / 当前分支快照，交互控件需在 Piora 中使用。</p>${snapshots.map(snapshot => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(snapshot)}</pre>`).join("")}</section>`;
}
