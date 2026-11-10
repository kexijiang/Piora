import { existsSync } from "node:fs";
import { answerOutputGenerationPath, answerOutputStatePath } from "../answer-output-paths";
import type { AnswerOutputPersistenceAdapter } from "../answer-output-persistence";

export const persistence: AnswerOutputPersistenceAdapter = {
  async copy(source, target, retainedEntryIds, options) {
    let inherited = false;
    if (existsSync(answerOutputGenerationPath(source)) || options.sourceFile && options.targetFile) {
      if (!options.sourceFile || !options.targetFile) throw new Error("Generation inheritance requires the source and target session files");
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const { copyGenerationJournal } = await import("./generation-journal");
      await copyGenerationJournal({ source, target, retainedEntryIds, sourceFile: options.sourceFile,
        targetFile: options.targetFile, sourceLeafId: options.sourceLeafId, root: getAgentDir(), includeLegacy: true });
      inherited = true;
    }
    if (!inherited && existsSync(answerOutputStatePath("intelligent-ui", source))) {
      (await import("./store")).copyIntelligentUiState(source, target, retainedEntryIds);
    }
  },
  async snapshots(sessionId, sessionFile, snapshot) {
    const { intelligentUiSessionReader } = await import("./session");
    const manager = snapshot ?? (await intelligentUiSessionReader(sessionId, sessionFile))();
    return (await import("./read-output")).readUiSnapshots(manager);
  },
  async readSnapshot(sessionId, sessionFile, toolCallId) {
    const { intelligentUiSessionReader } = await import("./session");
    const manager = (await intelligentUiSessionReader(sessionId, sessionFile))();
    return (await (await import("./read-output")).readUiOutput(manager, toolCallId)).snapshot;
  },
};
