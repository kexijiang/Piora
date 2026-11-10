import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AnswerOutputPersistenceAdapter } from "../answer-output-persistence";
import { answerOutputSessionReader } from "../answer-output-session";
import { copyMiniAppJournal, miniAppJournalPath, readMiniAppSnapshotRecords } from "./journal";
import { miniAppStatePath } from "./state-store";
import { MiniAppError } from "./limits";

function snapshot(value: Awaited<ReturnType<typeof readMiniAppSnapshotRecords>>[number]): string {
  const { record, saved } = value;
  return [record.plan.title, record.status === "committed" ? "Saved interactive result / 已确认的交互结果" : "Unpublished snapshot / 未发布快照",
    record.plan.purpose, ...record.plan.assumptions.map(text => `Assumption / 假设: ${text}`),
    ...record.plan.inputs.map(input => `${input.label}: ${String(saved.result.snapshot.inputs[input.id])} (${input.meaning})`),
    saved.result.frame.summary,
    ...(saved.result.frame.repeats ? ["Saved list rows / 已保存列表: " + JSON.stringify(saved.result.frame.repeats)] : []),
    `Revision / 版本: ${record.revision}; state / 状态: ${saved.stateRevision}; tick: ${saved.result.snapshot.tick}`].join("\n");
}

export const persistence: AnswerOutputPersistenceAdapter = {
  async copy(source, target, retainedEntryIds, options) {
    const root = getAgentDir();
    if (!options.sourceFile || !options.targetFile) {
      if (existsSync(miniAppJournalPath(source, root)) || existsSync(miniAppStatePath(source, root))) {
        throw new MiniAppError("IDENTITY", "Mini app inheritance requires both session files");
      }
      return;
    }
    await copyMiniAppJournal({ source, target, retainedEntryIds, sourceFile: options.sourceFile, targetFile: options.targetFile, sourceLeafId: options.sourceLeafId, root });
  },
  async snapshots(sessionId, sessionFile, managerSnapshot) {
    const manager = managerSnapshot ?? (await answerOutputSessionReader(sessionId, sessionFile))();
    if (manager.getSessionId() !== sessionId) throw new MiniAppError("IDENTITY", "Snapshot belongs to another session");
    const leafId = manager.getLeafId();
    return leafId ? (await readMiniAppSnapshotRecords(sessionId, sessionFile, leafId, getAgentDir())).map(snapshot) : [];
  },
  async readSnapshot(sessionId, sessionFile, toolCallId) {
    const manager = (await answerOutputSessionReader(sessionId, sessionFile))(), leafId = manager.getLeafId();
    const output = leafId ? (await readMiniAppSnapshotRecords(sessionId, sessionFile, leafId, getAgentDir(), toolCallId))[0] : undefined;
    if (!output) throw new MiniAppError("NOT_FOUND", "Mini app snapshot is not on this branch");
    return snapshot(output);
  },
};
