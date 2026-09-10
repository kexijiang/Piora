"use client";
import { useClipboardI18n } from "./useClipboardI18n";
import { useCallback, useRef, useState } from "react";

export interface ClipboardDraft {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<void>;
  discard: () => void | Promise<void>;
}

/** Keep navigation pending until the current preview has saved or discarded. */
export function useClipboardDraftGuard(report: (error: unknown) => void) {
  const { tr } = useClipboardI18n();
  const draft = useRef<ClipboardDraft | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const register = useCallback((value: ClipboardDraft | null) => { draft.current = value; }, []);
  const guard = useCallback((action: () => void) => {
    if (draft.current?.dirty) { pending.current = action; setOpen(true); }
    else action();
  }, []);
  const cancel = () => { if (!saving) { pending.current = null; setOpen(false); } };
  const finish = async (save: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      if (draft.current?.busy) throw new Error(tr("正在保存，请稍后再试。"));
      if (save) await draft.current?.save(); else await draft.current?.discard();
      const action = pending.current; pending.current = null; setOpen(false); action?.();
    } catch (error) { report(error); }
    finally { setSaving(false); }
  };
  return { draft, register, guard, open, saving, cancel, finish };
}
