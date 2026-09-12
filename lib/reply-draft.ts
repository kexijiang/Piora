import type { ReplyGroup, ReplyOption } from "./reply-suggestions";

/** Offsets are UTF-16, matching textarea selectionStart/End. */
export interface ReplySpan { key: string; source: string; groupId: string; optionId: string; start: number; end: number; originalText: string; edited: boolean; separator: boolean }
export interface ReplyDraft { value: string; spans: ReplySpan[] }
export function editReplyDraft(draft: ReplyDraft, value: string): ReplyDraft {
  if (draft.value === value) return draft;
  let start = 0;
  while (start < draft.value.length && start < value.length && draft.value[start] === value[start]) start++;
  let oldEnd = draft.value.length, newEnd = value.length;
  while (oldEnd > start && newEnd > start && draft.value[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  const spans = draft.spans.flatMap((span): ReplySpan[] => {
    if (oldEnd <= span.start && start < span.start) return [{ ...span, start: span.start + delta, end: span.end + delta }];
    if (start > span.end || (start === span.end && oldEnd > start)) return [span];
    if (start <= span.start && oldEnd >= span.end && oldEnd > start) return [];
    // A selection spanning owned and handwritten text cannot safely keep ownership.
    // Detach rather than letting a later removal consume somebody else's text.
    if ((start < span.start && oldEnd > span.start) || (start < span.end && oldEnd > span.end)) return [];
    const nextStart = Math.min(span.start, start < span.start ? start : span.start);
    const nextEnd = Math.max(nextStart, oldEnd >= span.end ? newEnd : span.end + delta);
    if (nextStart === nextEnd) return [];
    return [{ ...span, start: nextStart, end: nextEnd, edited: true, separator: span.separator && start > span.start - 1 }];
  });
  return { value, spans };
}
export function replySpanKey(source: string, option: ReplyOption) { return `${source}:${option.id}`; }
export function removeReplySpan(draft: ReplyDraft, span: ReplySpan): ReplyDraft {
  const start = span.separator && span.start > 0 && draft.value[span.start - 1] === "\n" ? span.start - 1 : span.start;
  const following = start === 0 ? draft.spans.find((s) => s.key !== span.key && s.start === span.end + 1 && s.separator && draft.value[span.end] === "\n") : undefined;
  const end = span.end + (following ? 1 : 0);
  return { value: draft.value.slice(0, start) + draft.value.slice(end), spans: draft.spans.filter((s) => s.key !== span.key).map((s) => s.start >= end ? { ...s, start: s.start - (end - start), end: s.end - (end - start), separator: s.key === following?.key ? false : s.separator } : s) };
}
export function chooseReply(draft: ReplyDraft, source: string, group: ReplyGroup, option: ReplyOption, force = false): { draft: ReplyDraft; conflict?: ReplySpan; caret?: number } {
  const key = replySpanKey(source, option);
  const selected = draft.spans.find((s) => s.key === key);
  const previous = selected ?? (group.selectionMode === "single" ? draft.spans.find((s) => s.source === source && s.groupId === group.id) : undefined);
  if (previous?.edited && !force) return { draft, conflict: previous };
  if (selected) return { draft: removeReplySpan(draft, selected), caret: selected.start };
  if (previous) {
    const value = draft.value.slice(0, previous.start) + option.insertText + draft.value.slice(previous.end);
    const delta = option.insertText.length - (previous.end - previous.start);
    return { draft: { value, spans: draft.spans.map((s) => s.key === previous.key ? { ...s, key, optionId: option.id, end: s.start + option.insertText.length, originalText: option.insertText, edited: false } : s.start >= previous.end ? { ...s, start: s.start + delta, end: s.end + delta } : s) }, caret: previous.start + option.insertText.length };
  }
  const separator = draft.value.length > 0 && !draft.value.endsWith("\n");
  const start = draft.value.length + (separator ? 1 : 0);
  const value = draft.value + (separator ? "\n" : "") + option.insertText;
  return { draft: { value, spans: [...draft.spans, { key, source, groupId: group.id, optionId: option.id, start, end: value.length, originalText: option.insertText, edited: false, separator }] }, caret: value.length };
}
export function clearReplySelections(draft: ReplyDraft, source?: string): { draft: ReplyDraft; retained: number } {
  let next = draft;
  const owned = draft.spans.filter((s) => source === undefined || s.source === source);
  for (const span of [...owned].sort((a, b) => b.start - a.start)) if (!span.edited) next = removeReplySpan(next, span);
  return { draft: { ...next, spans: next.spans.filter((s) => source !== undefined && s.source !== source) }, retained: owned.filter((s) => s.edited).length };
}
