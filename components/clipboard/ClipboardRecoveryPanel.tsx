"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useClipboardI18n } from "./useClipboardI18n";
import { listClipboardDrafts, readClipboardDraft, removeClipboardDraft, subscribeClipboardDrafts, type ClipboardRecoveryDraft, type ClipboardDraftSummary } from "./clipboard-draft-store";
import styles from "./ClipboardWorkspace.module.css";

export function ClipboardRecoveryPanel({ guard, onRestore }: { guard: (action: () => void) => void; onRestore: (draft: ClipboardRecoveryDraft) => Promise<void> }) {
  const { tr, locale } = useClipboardI18n();
  const [open, setOpen] = useState(false), [items, setItems] = useState<ClipboardDraftSummary[]>([]), [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ClipboardRecoveryDraft | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [limit, setLimit] = useState(50);
  const modal = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { if (!busy) { setOpen(false); setSelected(null); setConfirm(false); } }, [busy]);
  useFocusTrap(modal, open, { onEscape: close });
  useEffect(() => {
    let alive = true, generation = 0;
    const refresh = () => {
      const token = ++generation;
      void listClipboardDrafts(limit).then(value => { if (alive && token === generation) { setItems(value.items); setTotal(value.total); } }, () => { if (alive) setError("无法读取编辑草稿，请稍后重试。"); });
    };
    refresh(); const unsubscribe = subscribeClipboardDrafts(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [limit, open]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    try { await action(); } catch { setError("操作未完成，草稿仍保留。原记录可能已被删除，可先下载草稿。"); } finally { setBusy(false); }
  };
  const download = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.text, "\n\n", tr("草稿备注"), ":\n", selected.remark], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "clipboard-draft.txt"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  if (!total && !open && !error) return null;
  return <>
    <div className={styles.notice}><button onClick={() => guard(() => setOpen(true))}>{tr("未完成的编辑（{count}）", { count: total })}</button></div>
    {open ? <div ref={modal} className={styles.overlay} role="dialog" aria-modal="true" aria-label={tr("未完成的编辑")} onKeyDown={event => event.stopPropagation()}><div className={styles.dialog}>
      <h3>{tr("未完成的编辑")}</h3><p>{tr("草稿仅保存在本机。保存或明确删除前会一直保留。")}</p>
      {error ? <p role="alert">{tr(error)}</p> : null}
      {selected ? <>
        <strong>{selected.title}</strong>
        <label>{tr("草稿正文")}<textarea readOnly value={selected.text} /></label>
        <label>{tr("草稿备注")}<textarea readOnly value={selected.remark} /></label>
        <div className={styles.recoveryActions}>
          <button className={styles.primary} disabled={busy} onClick={() => void run(async () => { await onRestore(selected); setOpen(false); setSelected(null); })}>{tr("继续编辑草稿")}</button>
          <button disabled={busy} onClick={download}>{tr("下载草稿")}</button>
          <button disabled={busy} onClick={() => { if (!confirm) setConfirm(true); else void run(async () => { await removeClipboardDraft(selected.id, selected.revision); setSelected(null); setConfirm(false); }); }}>{confirm ? tr("确认删除这份草稿") : tr("删除草稿")}</button>
          <button disabled={busy} onClick={() => { setSelected(null); setConfirm(false); }}>{tr("返回草稿列表")}</button>
        </div>
      </> : <>
        <div className={styles.recoveryList}>{items.map(item => <button key={item.id} disabled={busy} onClick={() => void run(async () => { const value = await readClipboardDraft(item.id); if (!value) throw new Error(); setSelected(value); })}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString(locale)}</small></button>)}</div>
        {!items.length ? <p>{tr("没有未完成的编辑。")}</p> : null}
        {total > items.length ? <button onClick={() => setLimit(value => value + 50)}>{tr("加载更多草稿")}</button> : null}
      </>}
      <button disabled={busy} onClick={close}>{tr("关闭")}</button>
    </div></div> : null}
  </>;
}
