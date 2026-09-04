export type UiFontId =
  | "system"
  | "inter"
  | "yahei"
  | "dengxian"
  | "simsun"
  | "kaiti"
  | "consolas";

export type UiFontSize = number;
export type UiFontWeight = 400 | 500 | 700;

export interface UiFontPreset {
  id: UiFontId;
  nameKey: string;
  previewFamily: string;
  source: "adaptive" | "bundled" | "system";
  checkFamily?: string;
}

export interface FontPreference {
  schemaVersion: 1;
  family: UiFontId;
  size: UiFontSize;
  weight: UiFontWeight;
}

export const FONT_PREFERENCE_STORAGE_KEY = "pi-font-preference:v1";

export const UI_FONT_PRESETS: readonly UiFontPreset[] = [
  {
    id: "system",
    nameKey: "appearance.font.system",
    previewFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
    source: "adaptive",
  },
  {
    id: "inter",
    nameKey: "appearance.font.inter",
    previewFamily: "'Inter', 'Microsoft YaHei UI', sans-serif",
    source: "bundled",
    checkFamily: "Inter",
  },
  {
    id: "yahei",
    nameKey: "appearance.font.yahei",
    previewFamily: "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
    source: "system",
    checkFamily: "Microsoft YaHei UI",
  },
  {
    id: "dengxian",
    nameKey: "appearance.font.dengxian",
    previewFamily: "'DengXian', 'Microsoft YaHei UI', sans-serif",
    source: "system",
    checkFamily: "DengXian",
  },
  {
    id: "simsun",
    nameKey: "appearance.font.simsun",
    previewFamily: "'SimSun', 'Songti SC', serif",
    source: "system",
    checkFamily: "SimSun",
  },
  {
    id: "kaiti",
    nameKey: "appearance.font.kaiti",
    previewFamily: "'KaiTi', 'STKaiti', serif",
    source: "system",
    checkFamily: "KaiTi",
  },
  {
    id: "consolas",
    nameKey: "appearance.font.consolas",
    previewFamily: "'Consolas', var(--font-noto-mono), 'Microsoft YaHei UI', monospace",
    source: "system",
    checkFamily: "Consolas",
  },
] as const;

/** Common one-click choices. Any whole-pixel value in the range is accepted. */
export const UI_FONT_SIZES: readonly UiFontSize[] = [12, 14, 16, 18, 20, 24, 28, 32] as const;
export const UI_FONT_SIZE_MIN = 10;
export const UI_FONT_SIZE_MAX = 48;
export const UI_FONT_WEIGHTS: readonly UiFontWeight[] = [400, 500, 700];

export const DEFAULT_FONT_PREFERENCE: Readonly<FontPreference> = Object.freeze({
  schemaVersion: 1,
  family: "inter",
  size: 14,
  weight: 400,
});

const FONT_IDS = new Set<UiFontId>(UI_FONT_PRESETS.map(({ id }) => id));
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUiFontId(value: unknown): value is UiFontId {
  return typeof value === "string" && FONT_IDS.has(value as UiFontId);
}

export function isUiFontSize(value: unknown): value is UiFontSize {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= UI_FONT_SIZE_MIN
    && value <= UI_FONT_SIZE_MAX;
}

export function isUiFontWeight(value: unknown): value is UiFontWeight {
  return typeof value === "number" && UI_FONT_WEIGHTS.includes(value as UiFontWeight);
}

export function normalizeFontPreference(value: unknown): FontPreference {
  if (!isRecord(value)) return { ...DEFAULT_FONT_PREFERENCE };
  return {
    schemaVersion: 1,
    family: isUiFontId(value.family) ? value.family : DEFAULT_FONT_PREFERENCE.family,
    size: isUiFontSize(value.size) ? value.size : DEFAULT_FONT_PREFERENCE.size,
    weight: isUiFontWeight(value.weight) ? value.weight : DEFAULT_FONT_PREFERENCE.weight,
  };
}

export function parseStoredFontPreference(value: string | null): FontPreference {
  if (!value) return { ...DEFAULT_FONT_PREFERENCE };
  try {
    return normalizeFontPreference(JSON.parse(value) as unknown);
  } catch {
    return { ...DEFAULT_FONT_PREFERENCE };
  }
}

export function serializeFontPreference(preference: FontPreference): string {
  return JSON.stringify(normalizeFontPreference(preference));
}

const FONT_ID_JSON = JSON.stringify(UI_FONT_PRESETS.map(({ id }) => id));

/** Applies only validated data attributes before paint; all font stacks live in static CSS. */
export const FONT_PREFERENCE_INITIALIZATION_SCRIPT = `(function(){try{var f=${FONT_ID_JSON},w=${JSON.stringify(UI_FONT_WEIGHTS)},n=${UI_FONT_SIZE_MIN},m=${UI_FONT_SIZE_MAX},p=${JSON.stringify(DEFAULT_FONT_PREFERENCE)},v=localStorage.getItem("${FONT_PREFERENCE_STORAGE_KEY}");if(v){try{var x=JSON.parse(v);if(x&&f.indexOf(x.family)>-1)p.family=x.family;if(x&&Number.isInteger(x.size)&&x.size>=n&&x.size<=m)p.size=x.size;if(x&&w.indexOf(x.weight)>-1)p.weight=x.weight}catch(_){}}var r=document.documentElement;r.setAttribute("data-ui-font",p.family);r.setAttribute("data-ui-font-size",String(p.size));r.setAttribute("data-ui-font-weight",String(p.weight));r.style.setProperty("--ui-font-size",p.size+"px");r.style.setProperty("--ui-font-weight",String(p.weight))}catch(_){}})();`;
