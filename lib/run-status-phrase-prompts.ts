/**
 * Preset instructions for an optional model-written run status line.
 * Each prompt asks for one short line, without quotes or explanation,
 * in the language of the interface.
 */

export const RUN_STATUS_PHRASE_STYLES = ["poetry", "quote", "meme", "piora", "custom"] as const;

export type RunStatusPhraseStyle = (typeof RUN_STATUS_PHRASE_STYLES)[number];

export type RunStatusPhraseLocale = "zh-CN" | "en";

export const RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH = 2_000;

/** Upper bound for the prompt sent to the model, including the output rule. */
export const RUN_STATUS_PHRASE_PROMPT_MAX_LENGTH = 4_000;

export const RUN_STATUS_PHRASE_OUTPUT_RULE: Record<RunStatusPhraseLocale, string> = {
  "zh-CN": "使用简体中文。只输出一行，不超过40个字。不要引号、书名号、Markdown、作者、出处或解释。",
  en: "Use English. Output exactly one line of at most 80 characters. No quotation marks, markdown, attribution, or explanation.",
};

export const RUN_STATUS_PHRASE_PROMPTS: Record<Exclude<RunStatusPhraseStyle, "custom">, Record<RunStatusPhraseLocale, string>> = {
  poetry: {
    "zh-CN": `请随机给出一句著名的中国古典诗词名句，作为此刻的运行状态。\n${RUN_STATUS_PHRASE_OUTPUT_RULE["zh-CN"]}`,
    en: `Give one famous line of classical Chinese poetry, written in natural English, as the current run status.\n${RUN_STATUS_PHRASE_OUTPUT_RULE.en}`,
  },
  quote: {
    "zh-CN": `请随机给出一句著名的名人名言，作为此刻的运行状态。\n${RUN_STATUS_PHRASE_OUTPUT_RULE["zh-CN"]}`,
    en: `Give one famous quotation, written in natural English, as the current run status.\n${RUN_STATUS_PHRASE_OUTPUT_RULE.en}`,
  },
  meme: {
    "zh-CN": `请随机给出一句容易看懂、语气友好的中文网络梗，作为此刻轻松的运行状态。\n${RUN_STATUS_PHRASE_OUTPUT_RULE["zh-CN"]}`,
    en: `Give one short, friendly, widely recognizable internet-meme line in English as a light run status.\n${RUN_STATUS_PHRASE_OUTPUT_RULE.en}`,
  },
  piora: {
    "zh-CN": `请用 Piora 的品牌语气写一句原创运行状态。可以轻轻带上这些意象：圆周率 π、极光里的 ora、随身舱、桌宠，以及粉彩、星光、鼠尾草、樱雾这类皮肤与壁纸。\n${RUN_STATUS_PHRASE_OUTPUT_RULE["zh-CN"]}`,
    en: `Write one original run-status line in Piora's voice. You may touch these images lightly: pi (π), aurora and the syllable ora, the carry-pod, the desktop pet, and skins or wallpapers such as pastel, starlight, sage, and sakura mist.\n${RUN_STATUS_PHRASE_OUTPUT_RULE.en}`,
  },
};

export function isRunStatusPhraseStyle(value: unknown): value is RunStatusPhraseStyle {
  return typeof value === "string" && (RUN_STATUS_PHRASE_STYLES as readonly string[]).includes(value);
}

/**
 * Prompt for the selected style and interface language.
 * An empty custom prompt returns null so the caller keeps the fixed line.
 */
export function selectRunStatusPhrasePrompt(
  style: RunStatusPhraseStyle,
  locale: RunStatusPhraseLocale,
  customPrompt = "",
): string | null {
  if (style === "custom") {
    const custom = customPrompt.trim();
    if (!custom) return null;
    return `${custom}\n\n${RUN_STATUS_PHRASE_OUTPUT_RULE[locale]}`;
  }
  return RUN_STATUS_PHRASE_PROMPTS[style][locale];
}
