import {
  BACKGROUND_PREFERENCE_STORAGE_KEY,
  BACKGROUND_PRESETS,
  parseStoredBackgroundPreference,
  serializeBackgroundPreference,
  type BackgroundPreference,
} from "./backgrounds.ts";
import {
  FONT_PREFERENCE_STORAGE_KEY,
  isUiFontId,
  isUiFontSize,
  isUiFontWeight,
  normalizeFontPreference,
  parseStoredFontPreference,
  serializeFontPreference,
  type FontPreference,
} from "./font-preferences.ts";
import type { Locale } from "./i18n/types.ts";
import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isDarkTheme,
  isTheme,
  parseStoredTheme,
  serializeThemePreference,
  type Theme,
} from "../hooks/useTheme.ts";

export const PORTABLE_SETTINGS_MAX_BYTES = 64 * 1024;
export const SETTINGS_REOPEN_STORAGE_KEY = "piora-reopen-settings-after-import-v1";
export const COMPLETION_NOTIFICATION_STORAGE_KEY = "pi-completion-notifications-enabled";
export const GLOBAL_SHORTCUT_STORAGE_KEY = "piora-global-shortcut-enabled";
export const LOCALE_STORAGE_KEY = "pi-locale";

export type PortableSettingKey =
  | "theme"
  | "background"
  | "font"
  | "locale"
  | "completionNotifications"
  | "globalShortcut";

export type PortableSettingsExclusion = "customBackgroundImage";

export interface PortableSettingsPreferences {
  theme: Theme;
  background?: BackgroundPreference;
  font: FontPreference;
  locale: Locale;
  completionNotifications: boolean;
  globalShortcut: boolean;
}

export interface PortableSettingsBundle {
  product: "piora";
  schemaVersion: 1;
  exportedAt: string;
  excluded: PortableSettingsExclusion[];
  preferences: PortableSettingsPreferences;
}

export interface PortableSettingsDiff {
  key: PortableSettingKey;
  before: PortableSettingsPreferences[PortableSettingKey] | undefined;
  after: PortableSettingsPreferences[PortableSettingKey];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsPortabilityErrorCode = "oversized" | "malformed" | "product" | "version" | "unknown" | "invalid";

export class SettingsPortabilityError extends Error {
  readonly code: SettingsPortabilityErrorCode;

  constructor(code: SettingsPortabilityErrorCode) {
    super(code);
    this.code = code;
    this.name = "SettingsPortabilityError";
  }
}

const ROOT_KEYS = new Set(["product", "schemaVersion", "exportedAt", "excluded", "preferences"]);
const PREFERENCE_KEYS = new Set<PortableSettingKey>([
  "theme",
  "background",
  "font",
  "locale",
  "completionNotifications",
  "globalShortcut",
]);
const BACKGROUND_KEYS = new Set(["schemaVersion", "source", "presetId", "overlay", "blur"]);
const FONT_KEYS = new Set(["schemaVersion", "family", "size", "weight"]);
const BACKGROUND_IDS = new Set(BACKGROUND_PRESETS.map((preset) => preset.id));
const DIFF_ORDER: PortableSettingKey[] = ["theme", "background", "font", "locale", "completionNotifications", "globalShortcut"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN";
}

function isPortableBackground(value: unknown): value is BackgroundPreference {
  if (!isRecord(value) || !hasOnlyKeys(value, BACKGROUND_KEYS) || value.schemaVersion !== 1) return false;
  if (!Number.isInteger(value.overlay) || (value.overlay as number) < 0 || (value.overlay as number) > 90) return false;
  if (!Number.isInteger(value.blur) || (value.blur as number) < 0 || (value.blur as number) > 24) return false;
  if (value.source === "none") return value.presetId === null;
  return value.source === "builtin" && typeof value.presetId === "string" && BACKGROUND_IDS.has(value.presetId);
}

function isPortableFont(value: unknown): value is Omit<FontPreference, "weight"> & Partial<Pick<FontPreference, "weight">> {
  return isRecord(value)
    && hasOnlyKeys(value, FONT_KEYS)
    && value.schemaVersion === 1
    && isUiFontId(value.family)
    && isUiFontSize(value.size)
    && (value.weight === undefined || isUiFontWeight(value.weight));
}

function readBoolean(storage: StorageLike, key: string): boolean {
  return storage.getItem(key) === "true";
}

export function readPortableSettingsPreferences(
  storage: StorageLike,
  currentLocale: Locale,
): { preferences: PortableSettingsPreferences; excluded: PortableSettingsExclusion[] } {
  const theme = parseStoredTheme(storage.getItem(THEME_STORAGE_KEY))
    ?? parseStoredTheme(storage.getItem(LEGACY_THEME_STORAGE_KEY))
    ?? "light";
  const background = parseStoredBackgroundPreference(storage.getItem(BACKGROUND_PREFERENCE_STORAGE_KEY));
  const excluded: PortableSettingsExclusion[] = [];
  if (background.source === "custom") excluded.push("customBackgroundImage");

  return {
    excluded,
    preferences: {
      theme,
      ...(background.source !== "custom" ? { background } : {}),
      font: parseStoredFontPreference(storage.getItem(FONT_PREFERENCE_STORAGE_KEY)),
      locale: isLocale(storage.getItem(LOCALE_STORAGE_KEY)) ? storage.getItem(LOCALE_STORAGE_KEY) as Locale : currentLocale,
      completionNotifications: readBoolean(storage, COMPLETION_NOTIFICATION_STORAGE_KEY),
      globalShortcut: readBoolean(storage, GLOBAL_SHORTCUT_STORAGE_KEY),
    },
  };
}

export function createPortableSettingsBundle(
  storage: StorageLike,
  currentLocale: Locale,
  exportedAt = new Date(),
): PortableSettingsBundle {
  const current = readPortableSettingsPreferences(storage, currentLocale);
  return {
    product: "piora",
    schemaVersion: 1,
    exportedAt: exportedAt.toISOString(),
    excluded: current.excluded,
    preferences: current.preferences,
  };
}

export function serializePortableSettings(bundle: PortableSettingsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function parsePortableSettings(text: string): PortableSettingsBundle {
  if (new TextEncoder().encode(text).byteLength > PORTABLE_SETTINGS_MAX_BYTES) throw new SettingsPortabilityError("oversized");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SettingsPortabilityError("malformed");
  }
  if (!isRecord(value)) throw new SettingsPortabilityError("malformed");
  if (!hasOnlyKeys(value, ROOT_KEYS) || !isRecord(value.preferences) || !hasOnlyKeys(value.preferences, PREFERENCE_KEYS)) {
    throw new SettingsPortabilityError("unknown");
  }
  if (value.product !== "piora") throw new SettingsPortabilityError("product");
  if (value.schemaVersion !== 1) throw new SettingsPortabilityError("version");
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) throw new SettingsPortabilityError("invalid");
  if (!Array.isArray(value.excluded) || value.excluded.some((item) => item !== "customBackgroundImage")) {
    throw new SettingsPortabilityError("invalid");
  }

  const preferences = value.preferences;
  if (!isTheme(preferences.theme)
    || !isPortableFont(preferences.font)
    || !isLocale(preferences.locale)
    || typeof preferences.completionNotifications !== "boolean"
    || typeof preferences.globalShortcut !== "boolean"
    || (preferences.background !== undefined && !isPortableBackground(preferences.background))) {
    throw new SettingsPortabilityError("invalid");
  }

  return {
    product: "piora",
    schemaVersion: 1,
    exportedAt: value.exportedAt,
    excluded: [...new Set(value.excluded)] as PortableSettingsExclusion[],
    preferences: {
      theme: preferences.theme,
      ...(preferences.background ? { background: preferences.background } : {}),
      font: normalizeFontPreference(preferences.font),
      locale: preferences.locale,
      completionNotifications: preferences.completionNotifications,
      globalShortcut: preferences.globalShortcut,
    },
  };
}

export function getPortableSettingsDiff(
  current: PortableSettingsPreferences,
  incoming: PortableSettingsPreferences,
): PortableSettingsDiff[] {
  const diff: PortableSettingsDiff[] = [];
  for (const key of DIFF_ORDER) {
    const after = incoming[key];
    if (after === undefined) continue;
    const before = current[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({ key, before, after });
  }
  return diff;
}

export function applyPortableSettings(storage: StorageLike, bundle: PortableSettingsBundle): PortableSettingKey[] {
  const { preferences } = bundle;
  storage.setItem(THEME_STORAGE_KEY, serializeThemePreference(preferences.theme));
  storage.setItem(LEGACY_THEME_STORAGE_KEY, isDarkTheme(preferences.theme) ? "dark" : "light");
  if (preferences.background) storage.setItem(BACKGROUND_PREFERENCE_STORAGE_KEY, serializeBackgroundPreference(preferences.background));
  storage.setItem(FONT_PREFERENCE_STORAGE_KEY, serializeFontPreference(preferences.font));
  storage.setItem(LOCALE_STORAGE_KEY, preferences.locale);
  storage.setItem(COMPLETION_NOTIFICATION_STORAGE_KEY, String(preferences.completionNotifications));
  storage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, String(preferences.globalShortcut));
  return DIFF_ORDER.filter((key) => key !== "background" || preferences.background !== undefined);
}
