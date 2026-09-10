/** Serializable desktop clipboard contracts. Safe to import as types in renderers. */
export type ClipboardKind = "text" | "link" | "image" | "files";
export type ClipboardFilter = "all" | "text" | "image" | "files" | "starred" | "trash" | "shelf";
export interface ClipboardSource { name: string; executable: string }
export interface ClipboardFile { path: string; name: string; directory: boolean; exists?: boolean }
export interface ClipboardCapture {
  text?: string; html?: string; rtf?: string; image?: Uint8Array;
  width?: number; height?: number; files?: ClipboardFile[]; source?: ClipboardSource;
}
export interface ClipboardAsset { hash: string; bytes: number; mime: "image/png" | "text/html" | "text/rtf"; width?: number; height?: number }
export interface ClipboardItem {
  id: string; kind: ClipboardKind; title: string; remark: string; preview: string;
  createdAt: number; copiedAt: number; copies: number; starred: boolean; deletedAt: number | null;
  source: ClipboardSource; bytes: number; fileCount: number;
  formats: Array<"text" | "html" | "rtf" | "image" | "files">;
  image: ClipboardAsset | null; shelfOrder: number | null;
}
export interface ClipboardDetail extends ClipboardItem {
  text: string | null; html: string | null; rtf: string | null; files: ClipboardFile[];
}
export interface ClipboardSettings {
  enabled: boolean; captureText: boolean; captureImages: boolean; captureFiles: boolean;
  excludedApps: string[]; budgetBytes: number;
}
export interface ClipboardStatus {
  storage?: "ready" | "failed" | "recovering";
  settings: ClipboardSettings; total: number; trash: number; shelf: number; bytes: number;
  budgetState: "ok" | "warning" | "full";
  revision: number; sources: ClipboardSource[]; migrationWarnings: string[];
  backupBytes: number; databaseBytes: number; listener: "native" | "polling" | "unavailable";
  locked: boolean; error: string; skipped: number; shortcut: string | null;
  target: string | null; canPaste: boolean; canDrag: boolean;
}
export interface ClipboardQuery {
  text?: string; filter?: ClipboardFilter; source?: string;
  after?: number; before?: number; cursor?: string; limit?: number; requestId?: number;
  direction?: "older" | "newer"; includeCursor?: boolean;
}
export interface ClipboardPage {
  items: ClipboardItem[]; nextCursor: string | null; previousCursor: string | null; revision: number; requestId: number;
}
export type ClipboardMutation =
  | { type: "star"; ids: string[]; value: boolean }
  | { type: "remark"; id: string; value: string }
  | { type: "edit-copy"; id: string; text: string }
  | { type: "delete" | "restore" | "purge"; ids: string[] }
  | { type: "clear-history" | "empty-trash" | "clear-shelf" }
  | { type: "shelf-add" | "shelf-remove" | "shelf-reorder"; ids: string[] }
  | { type: "shelf-move"; id: string; direction: "top" | "up" | "down" }
  | { type: "settings"; value: Partial<ClipboardSettings> };
export interface ClipboardOperation {
  ids: string[]; plain?: boolean; separator?: string; targetToken?: string;
}
export type ClipboardMutationResult = { id: string } | void;
export interface ClipboardOperationResult {
  status: "copied" | "input-sent" | "no-target" | "target-lost" | "input-blocked" | "modifiers-held";
  message: string;
}
export interface ClipboardChange { revision: number; reason: "capture" | "mutation" | "status" | "open"; targetToken?: string; error?: string }
export interface ClipboardBridge {
  reconnect: () => Promise<void>;
  onBeforeClose: (flush: () => Promise<void>) => () => void;
  setLocale: (locale: "en" | "zh-CN") => Promise<void>;
  query: (query: ClipboardQuery) => Promise<ClipboardPage>;
  cancelQuery: (requestId: number) => Promise<void>;
  getDetail: (id: string) => Promise<ClipboardDetail>;
  status: () => Promise<ClipboardStatus>;
  subscribe: (listener: (change: ClipboardChange) => void) => () => void;
  mutate: (mutation: ClipboardMutation) => Promise<ClipboardMutationResult>;
  capture: () => Promise<void>;
  copy: (operation: ClipboardOperation) => Promise<ClipboardOperationResult>;
  paste: (operation: ClipboardOperation) => Promise<ClipboardOperationResult>;
  prepareDrag: (ids: string[]) => Promise<boolean>;
  startDrag: (ids: string[]) => void;
  menu: (ids: string[]) => Promise<"copy" | "paste" | "plain" | "star" | "shelf-add" | "shelf-remove" | "shelf-top" | "shelf-up" | "shelf-down" | "delete" | "restore" | "purge" | "save" | null>;
  open: (surface: "quick" | "manager" | "shelf") => Promise<void>;
  hide: () => Promise<void>;
  saveAs: (id: string) => Promise<boolean>;
  exportArchive: () => Promise<boolean>;
  importArchive: () => Promise<{ imported: number; merged: number; warnings: string[] } | null>;
  revealFile: (id: string, index: number) => Promise<void>;
  openLink: (id: string) => Promise<void>;
  asset: (id: string, thumbnail?: boolean) => Promise<string>;
}
export const DEFAULT_CLIPBOARD_SETTINGS: ClipboardSettings = {
  enabled: true, captureText: true, captureImages: true, captureFiles: true,
  excludedApps: [], budgetBytes: 1024 ** 3,
};
export const CLIPBOARD_TEXT_LIMIT = 2 * 1024 ** 2;
export const CLIPBOARD_PAYLOAD_LIMIT = 64 * 1024 ** 2;
export const CLIPBOARD_TRASH_AGE = 7 * 86400_000;
