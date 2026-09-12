"use client";
import { useCallback, useRef, useState, type SetStateAction } from "react";
import { editReplyDraft, type ReplyDraft } from "@/lib/reply-draft";

export function useReplyDraft(initial: () => ReplyDraft) {
  const [draft, update] = useState(initial);
  const current = useRef(draft);
  const undoStack = useRef<ReplyDraft[]>([]), redoStack = useRef<ReplyDraft[]>([]);
  const commit = useCallback((next: ReplyDraft, record = true) => {
    if (next === current.current) return;
    if (record) { undoStack.current.push(current.current); if (undoStack.current.length > 100) undoStack.current.shift(); redoStack.current = []; }
    current.current = next; update(next);
  }, []);
  const setValue = useCallback((action: SetStateAction<string>) => {
    const value = typeof action === "function" ? action(current.current.value) : action;
    commit(editReplyDraft(current.current, value));
  }, [commit]);
  const reset = useCallback((next: ReplyDraft) => { undoStack.current = []; redoStack.current = []; commit(next, false); }, [commit]);
  const undo = useCallback((redo = false) => {
    const source = redo ? redoStack : undoStack, destination = redo ? undoStack : redoStack;
    const next = source.current.pop();
    if (!next) return false;
    destination.current.push(current.current); commit(next, false); return true;
  }, [commit]);
  return { draft, current, setValue, commit, reset, undo };
}
