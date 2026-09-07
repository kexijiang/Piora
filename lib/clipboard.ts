/** Clipboard actions are only called in response to a user gesture. */
export async function readClipboardText(): Promise<string> {
  if (window.piDesktop?.clipboard) return window.piDesktop.clipboard.readText();
  if (!navigator.clipboard?.readText) throw new Error("Clipboard unavailable");
  return navigator.clipboard.readText();
}

export async function copyText(text: string): Promise<void> {
  if (window.piDesktop?.clipboard) return window.piDesktop.clipboard.writeText(text);
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* A browser may expose the API but deny permission. Try user-gesture copy. */ }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;inset:0;pointer-events:none";
  document.body.appendChild(ta);
  try {
    ta.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was denied");
  } finally {
    ta.remove(); active?.focus({ preventScroll: true });
    selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range);
  }
}
