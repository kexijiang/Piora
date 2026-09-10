"use client";
import { useRef, useState } from "react";
import type { ClipboardDetail } from "@/desktop/src/clipboard-types";
import { removeClipboardDraft, writeClipboardDraft, type ClipboardRecoveryDraft } from "./clipboard-draft-store";

export function useClipboardRecovery(entry: ClipboardDetail, recovered?: ClipboardRecoveryDraft | null) {
  const [id] = useState(() => crypto.randomUUID());
  const latest = useRef<ClipboardRecoveryDraft | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<"idle" | "writing" | "saved" | "failed">("idle");
  const sequence = useRef(0);
  const remove = async () => {
    const captured = latest.current, writing = pending.current;
    await writing.catch(() => {});
    if (captured) await removeClipboardDraft(id, captured.revision);
    if (recovered) await removeClipboardDraft(recovered.id, recovered.revision);
    if (latest.current === captured) { latest.current = null; setState("idle"); }
  };
  const write = (text: string, remark: string, baseText: string, baseRemark: string) => {
    const token = ++sequence.current;
    if (text === baseText && remark === baseRemark) {
      // Serialize a revert after every admitted write, so an old write cannot resurrect it.
      const promise = remove(); pending.current = promise;
      void promise.catch(() => { if (token === sequence.current) setState("failed"); });
      return promise;
    }
    const value = { id, revision: crypto.randomUUID(), entryId: entry.id, title: entry.title, updatedAt: Date.now(), text, remark, baseText, baseRemark };
    latest.current = value; setState("writing");
    const promise = writeClipboardDraft(value); pending.current = promise;
    void promise.then(() => { if (token === sequence.current) setState("saved"); }, () => { if (token === sequence.current) setState("failed"); });
    return promise;
  };
  const clear = async () => { ++sequence.current; await remove(); };
  return { write, clear, state, retry: () => {
    const draft = latest.current;
    return draft ? write(draft.text, draft.remark, draft.baseText, draft.baseRemark) : clear();
  } };
}
