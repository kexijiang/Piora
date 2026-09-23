/** The SDK triggers auto-compaction above contextWindow - reserveTokens. */
export interface CompactionThresholdSettings {
  reserveTokens: number;
}

interface CompactionSettingsManager {
  getCompactionReserveTokens(): number;
  globalSettings: { compaction?: { reserveTokens?: number } };
  markModified(field: string, nestedKey?: string): void;
  save(): void;
  flush(): Promise<void>;
  drainErrors(): Array<{ error: Error }>;
}

export function parseCompactionThresholdSettings(value: unknown): CompactionThresholdSettings {
  const reserveTokens = (value as Partial<CompactionThresholdSettings> | null)?.reserveTokens;
  if (!Number.isInteger(reserveTokens) || (reserveTokens as number) < 0 || (reserveTokens as number) > 131_072) {
    throw new TypeError("reserveTokens must be an integer between 0 and 131072");
  }
  return { reserveTokens: reserveTokens as number };
}

export function readCompactionThresholdSettings(manager: Pick<CompactionSettingsManager, "getCompactionReserveTokens">): CompactionThresholdSettings {
  return { reserveTokens: manager.getCompactionReserveTokens() };
}

export async function applyCompactionThresholdSettings(manager: unknown, settings: CompactionThresholdSettings): Promise<CompactionThresholdSettings> {
  const writer = manager as CompactionSettingsManager;
  const compaction = writer.globalSettings.compaction ?? (writer.globalSettings.compaction = {});
  if (compaction.reserveTokens !== settings.reserveTokens) {
    compaction.reserveTokens = settings.reserveTokens;
    writer.markModified("compaction", "reserveTokens");
    writer.save();
    await writer.flush();
    const errors = writer.drainErrors();
    if (errors.length) throw errors[0].error;
  }
  return readCompactionThresholdSettings(writer);
}
