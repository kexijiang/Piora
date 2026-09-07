export const COMPANION_STORAGE_KEY = "pi-companion-preferences-v1";
export const COMPANION_SCHEMA_VERSION = 4;
export const DEFAULT_COMPANION_PET_ID = "pekka-pal.codex-pet";
export const BUNDLED_COMPANION_PETS_PUBLIC_PATH = "/companion-pets/bundled";
export const BUNDLED_COMPANION_PET_IDS = Object.freeze([
  "azure",
  "corgi-scout",
  "fox",
  "patchi",
  DEFAULT_COMPANION_PET_ID,
  "penguin",
  "professor-hoot",
  "rabbit",
  "shadow-kit",
] as const);
export const MAX_COMPANION_TODOS = 100;
export const MAX_COMPANION_PHRASES = 24;
export const MAX_COMPANION_LIBRARY_ITEMS = 80;
export const MAX_COMPANION_IMAGE_BYTES = 1_250_000;

const MAX_TODO_LENGTH = 240;
const MAX_TODO_NOTES_LENGTH = 2_000;
const MAX_PHRASE_LABEL_LENGTH = 40;
const MAX_PHRASE_TEXT_LENGTH = 2_000;
const MAX_LIBRARY_TITLE_LENGTH = 120;
const MAX_LIBRARY_CONTENT_LENGTH = 40_000;

export interface CompanionTodo {
  id: string;
  text: string;
  completed: boolean;
  progress: number;
  notes?: string;
  project?: string;
  dueAt?: number;
  reminderEnabled?: boolean;
  nextReminderAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionQuickPhrase {
  id: string;
  label: string;
  text: string;
}

export type CompanionLibraryKind = "note" | "code" | "command" | "image";

export interface CompanionLibraryItem {
  id: string;
  kind: CompanionLibraryKind;
  title: string;
  content: string;
  language?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionInteractionModel {
  provider: string;
  modelId: string;
}

export interface CompanionPreferences {
  version: typeof COMPANION_SCHEMA_VERSION;
  open: boolean;
  alwaysOnTop: boolean;
  selectedPetId: string;
  todos: CompanionTodo[];
  phrases: CompanionQuickPhrase[];
  library: CompanionLibraryItem[];
  idleTricks: boolean;
  interactionModel: CompanionInteractionModel | null;
  shareWorkContext: boolean;
}

export interface CompanionPhraseSeed {
  label: string;
  text: string;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeId(value: unknown, fallback: string): string {
  const id = cleanText(value, 120);
  return /^[a-zA-Z0-9._:-]+$/.test(id) ? id : fallback;
}

function safeTimestamp(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeProgress(value: unknown, completed: boolean): number {
  if (completed) return 100;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(99, Math.round(value)))
    : 0;
}

function normalizeInteractionModel(value: unknown): CompanionInteractionModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = cleanText(record.provider, 120);
  const modelId = cleanText(record.modelId, 240);
  return provider && modelId ? { provider, modelId } : null;
}

export function createCompanionId(prefix: "todo" | "phrase" | "library"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function createDefaultCompanionPreferences(seeds: CompanionPhraseSeed[] = []): CompanionPreferences {
  return {
    version: COMPANION_SCHEMA_VERSION,
    open: false,
    alwaysOnTop: true,
    selectedPetId: DEFAULT_COMPANION_PET_ID,
    todos: [],
    phrases: seeds.slice(0, MAX_COMPANION_PHRASES).flatMap((seed, index) => {
      const label = cleanText(seed.label, MAX_PHRASE_LABEL_LENGTH);
      const text = cleanText(seed.text, MAX_PHRASE_TEXT_LENGTH);
      return label && text ? [{ id: `phrase:default-${index + 1}`, label, text }] : [];
    }),
    library: [],
    idleTricks: true,
    interactionModel: null,
    shareWorkContext: true,
  };
}

// Older data migrates forward so existing todos and phrases survive. Unknown
// newer schemas are rejected to avoid silently discarding future fields.
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3, COMPANION_SCHEMA_VERSION]);

export function normalizeCompanionPreferences(
  value: unknown,
  fallback: CompanionPreferences = createDefaultCompanionPreferences(),
): CompanionPreferences {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(record.version as number)) return fallback;
  const rawTodos = Array.isArray(record.todos) ? record.todos : [];
  const todos = rawTodos.slice(0, MAX_COMPANION_TODOS).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const todo = candidate as Record<string, unknown>;
    const text = cleanText(todo.text, MAX_TODO_LENGTH);
    if (!text) return [];
    const completed = todo.completed === true;
    const createdAt = safeTimestamp(todo.createdAt);
    const notes = cleanText(todo.notes, MAX_TODO_NOTES_LENGTH);
    const project = cleanText(todo.project, 160);
    const dueAt = safeTimestamp(todo.dueAt, -1);
    return [{
      id: safeId(todo.id, `todo:restored-${index + 1}`),
      text,
      completed,
      progress: safeProgress(todo.progress, completed),
      ...(notes ? { notes } : {}),
      ...(project ? { project } : {}),
      ...(dueAt >= 0 ? { dueAt } : {}),
      ...(typeof todo.reminderEnabled === "boolean" ? { reminderEnabled: todo.reminderEnabled } : {}),
      ...(safeTimestamp(todo.nextReminderAt, -1) >= 0 ? { nextReminderAt: safeTimestamp(todo.nextReminderAt) } : {}),
      createdAt,
      updatedAt: safeTimestamp(todo.updatedAt, createdAt),
    }];
  });

  const rawPhrases = Array.isArray(record.phrases) ? record.phrases : [];
  const phrases = rawPhrases.slice(0, MAX_COMPANION_PHRASES).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const phrase = candidate as Record<string, unknown>;
    const label = cleanText(phrase.label, MAX_PHRASE_LABEL_LENGTH);
    const text = cleanText(phrase.text, MAX_PHRASE_TEXT_LENGTH);
    if (!label || !text) return [];
    return [{ id: safeId(phrase.id, `phrase:restored-${index + 1}`), label, text }];
  });

  const rawLibrary = Array.isArray(record.library) ? record.library : [];
  const library = rawLibrary.slice(0, MAX_COMPANION_LIBRARY_ITEMS).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const kind = ["note", "code", "command", "image"].includes(String(item.kind))
      ? item.kind as CompanionLibraryKind
      : "note";
    const title = cleanText(item.title, MAX_LIBRARY_TITLE_LENGTH);
    const content = cleanText(item.content, kind === "image" ? MAX_COMPANION_IMAGE_BYTES * 2 : MAX_LIBRARY_CONTENT_LENGTH);
    const validImage = kind !== "image" || /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(content);
    if (!title || !content || !validImage) return [];
    const createdAt = safeTimestamp(item.createdAt);
    const language = cleanText(item.language, 40);
    return [{
      id: safeId(item.id, `library:restored-${index + 1}`),
      kind,
      title,
      content,
      ...(language ? { language } : {}),
      pinned: item.pinned === true,
      createdAt,
      updatedAt: safeTimestamp(item.updatedAt, createdAt),
    }];
  });

  return {
    version: COMPANION_SCHEMA_VERSION,
    open: record.open === true,
    alwaysOnTop: record.alwaysOnTop !== false,
    selectedPetId: safeId(record.selectedPetId, "builtin"),
    todos,
    phrases,
    library,
    idleTricks: record.idleTricks !== false,
    interactionModel: normalizeInteractionModel(record.interactionModel),
    shareWorkContext: record.shareWorkContext !== false,
  };
}

export function parseCompanionPreferences(
  raw: string | null,
  fallback: CompanionPreferences = createDefaultCompanionPreferences(),
): CompanionPreferences {
  if (!raw) return fallback;
  try {
    return normalizeCompanionPreferences(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
}
