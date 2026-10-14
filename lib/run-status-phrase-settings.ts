import {
  isRunStatusPhraseStyle,
  RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH,
  type RunStatusPhraseStyle,
} from "./run-status-phrase-prompts";

export const RUN_STATUS_PHRASE_STORAGE_KEY = "piora-run-status-phrase:v1";

export interface RunStatusPhrasePreference {
  schemaVersion: 1;
  enabled: boolean;
  style: RunStatusPhraseStyle;
  customPrompt: string;
}

export const DEFAULT_RUN_STATUS_PHRASE_PREFERENCE: Readonly<RunStatusPhrasePreference> = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  style: "piora",
  customPrompt: "",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundRunStatusCustomPrompt(value: string): string {
  return Array.from(value).slice(0, RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH).join("");
}

export function normalizeRunStatusPhrasePreference(value: unknown): RunStatusPhrasePreference {
  if (!isRecord(value)) return { ...DEFAULT_RUN_STATUS_PHRASE_PREFERENCE };
  return {
    schemaVersion: 1,
    enabled: value.enabled === true,
    style: isRunStatusPhraseStyle(value.style) ? value.style : DEFAULT_RUN_STATUS_PHRASE_PREFERENCE.style,
    customPrompt: typeof value.customPrompt === "string" ? boundRunStatusCustomPrompt(value.customPrompt) : "",
  };
}

export function parseStoredRunStatusPhrasePreference(value: string | null): RunStatusPhrasePreference {
  if (!value) return { ...DEFAULT_RUN_STATUS_PHRASE_PREFERENCE };
  try {
    return normalizeRunStatusPhrasePreference(JSON.parse(value) as unknown);
  } catch {
    return { ...DEFAULT_RUN_STATUS_PHRASE_PREFERENCE };
  }
}

export function serializeRunStatusPhrasePreference(preference: RunStatusPhrasePreference): string {
  return JSON.stringify(normalizeRunStatusPhrasePreference(preference));
}
