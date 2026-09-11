import type { ClipboardFilter, ClipboardItem } from "@/desktop/src/clipboard-types";

export type ClipboardSurface = "quick" | "manager" | "shelf";
export function clipboardRowHeight(surface: ClipboardSurface, item: ClipboardItem) {
  return surface === "shelf" ? item.kind === "image" ? 128 : item.kind === "files" ? 72 : 84 : item.kind === "image" ? 112 : surface === "manager" ? 64 : 56;
}
export function clipboardCursor(item: ClipboardItem, filter: ClipboardFilter): string {
  const value = JSON.stringify([filter === "shelf" ? item.shelfOrder : item.copiedAt, item.id]);
  return btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function clipboardAnchor(items: ClipboardItem[], scroll: number, surface: ClipboardSurface) {
  let top = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index], height = clipboardRowHeight(surface, item);
    if (top + height > scroll) return { id: item.id, index, offset: Math.max(0, scroll - top) };
    top += height;
  }
  return null;
}
export function clipboardAnchorScroll(items: ClipboardItem[], anchor: ReturnType<typeof clipboardAnchor>, surface: ClipboardSurface) {
  if (!anchor) return 0;
  const found = items.findIndex(item => item.id === anchor.id), index = found < 0 ? Math.min(anchor.index, Math.max(0, items.length - 1)) : found;
  return items.slice(0, index).reduce((height, item) => height + clipboardRowHeight(surface, item), 0) + anchor.offset;
}
export function mergeClipboardWindow(existing: ClipboardItem[], incoming: ClipboardItem[], direction: "older" | "newer", scroll: number, surface: ClipboardSurface) {
  const anchor = clipboardAnchor(existing, scroll, surface), known = new Set(existing.map(item => item.id));
  const additions = incoming.filter(item => !known.has(item.id));
  const combined = direction === "older" ? [...existing, ...additions] : [...additions, ...existing];
  const trimmed = combined.length > 500;
  const items = direction === "older" ? combined.slice(-500) : combined.slice(0, 500);
  return { items, scroll: clipboardAnchorScroll(items, anchor, surface), trimmed };
}
