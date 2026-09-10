"use client";
import { useClipboardI18n } from "./useClipboardI18n";
/* eslint-disable @next/next/no-img-element -- Scoped local clipboard images, not web assets. */
import { useEffect, useMemo, useState } from "react";
import type { ClipboardBridge, ClipboardDetail } from "@/desktop/src/clipboard-types";
import { AliIcon } from "@/components/AliIcon";
import type { ClipboardDraft } from "./useClipboardDraftGuard";
import { clipboardByteLabel, clipboardTextMetrics, clipboardWebLink } from "@/desktop/src/clipboard-content";
import styles from "./ClipboardWorkspace.module.css";
import { useClipboardRecovery } from "./useClipboardRecovery";
import type { ClipboardRecoveryDraft } from "./clipboard-draft-store";

export function safeClipboardDocument(html: string, scheme: "light" | "dark" = "light", tr: (message: string) => string = message => message): string {
  const previewLimit = 256_000;
  let shortened = html.length > previewLimit;
  const parsed = new DOMParser().parseFromString(html.slice(0, previewLimit), "text/html");
  const allowed = new Set("p br strong em b i u s code pre ul ol li table thead td th tbody tr blockquote hr h1 h2 h3 h4 h5 h6 span div sub sup".split(" "));
  const output = document.implementation.createHTMLDocument("");
  const pending: Array<{ node: Node; parent: Node }> = [...parsed.body.childNodes].reverse().map(node => ({ node, parent: output.body }));
  let visited = 0;
  while (pending.length) {
    if (++visited > 10_000) { shortened = true; break; }
    const { node, parent } = pending.pop()!;
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(output.createTextNode(node.textContent ?? "")); continue; }
    if (!(node instanceof Element)) continue;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "svg", "math", "form", "link", "meta"].includes(tag)) continue;
    const next = allowed.has(tag) ? output.createElement(tag) : parent;
    if (next instanceof Element && ["td", "th"].includes(tag)) for (const key of ["colspan", "rowspan"]) {
      const value = node.getAttribute(key); if (value && /^\d{1,2}$/.test(value)) next.setAttribute(key, value);
    }
    if (next !== parent) parent.appendChild(next);
    for (const child of [...node.childNodes].reverse()) pending.push({ node: child, parent: next });
  }
  if (shortened) { const notice = output.createElement("p"); notice.textContent = tr("内容较长，已缩短预览；复制或粘贴仍使用完整原格式。"); output.body.appendChild(notice); }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{color-scheme:${scheme}}body{background:Canvas;color:CanvasText;margin:16px;font:14px/1.65 system-ui;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px}</style>${output.body.innerHTML}`;
}

export function ClipboardImage({ bridge, id, title, thumbnail = false }: { bridge: ClipboardBridge; id: string; title: string; thumbnail?: boolean }) {
  const { tr } = useClipboardI18n();
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true; setUrl(""); setFailed(false);
    void bridge.asset(id, thumbnail).then(value => { if (alive) setUrl(attempt ? `${value}?retry=${attempt}` : value); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [bridge, id, thumbnail, attempt]);
  if (failed) return thumbnail ? <span aria-label={tr("图片缩略图不可用")}>▧</span> : <div role="status"><p>{tr("图片读取失败")}</p><button onClick={() => setAttempt(value => value + 1)}>{tr("重新加载图片")}</button></div>;
  return url ? <img alt={title} src={url} draggable={false} onError={() => setFailed(true)} /> : <span aria-label={tr("正在读取图片")}>▧</span>;
}

export function ClipboardPreview({ entry, bridge, onChanged, onError, onSave, onInteract, onCreated, onDraft, recovered, onRecoveryCleared }: { entry: ClipboardDetail; bridge: ClipboardBridge; onChanged: () => void; onError: (error: unknown) => void; onSave?: (entry: ClipboardDetail) => Promise<void>; onInteract?: () => void; onCreated: (id: string) => Promise<void>; onDraft: (draft: ClipboardDraft | null) => void; recovered?: ClipboardRecoveryDraft | null; onRecoveryCleared: () => void }) {
  const { tr, locale } = useClipboardI18n();
  const [remark, setRemark] = useState(recovered?.remark ?? entry.remark);
  const [savedRemark, setSavedRemark] = useState(entry.remark);
  const [editing, setEditing] = useState(Boolean(recovered && recovered.text !== recovered.baseText));
  const [text, setText] = useState(recovered?.text ?? entry.text ?? "");
  const [savedText, setSavedText] = useState(entry.text ?? "");
  const [busy, setBusy] = useState(false);
  const [rich, setRich] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [saved, setSaved] = useState("");
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const recovery = useClipboardRecovery(entry, recovered);
  const updateDraft = (nextText: string, nextRemark: string) => {
    setText(nextText); setRemark(nextRemark);
    void recovery.write(nextText, nextRemark, savedText, savedRemark).catch(() => {});
  };
  const shownText = editing ? text : entry.text;
  const metrics = useMemo(() => shownText === null ? null : clipboardTextMetrics(shownText), [shownText]);
  const link = useMemo(() => entry.kind === "link" ? clipboardWebLink(entry.text) : null, [entry.kind, entry.text]);
  const richDocument = useMemo(() => rich && entry.html ? safeClipboardDocument(entry.html, scheme, tr) : "", [rich, entry.html, scheme, tr]);
  useEffect(() => {
    const update = () => setScheme(getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light");
    update(); const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => observer.disconnect();
  }, []);
  const run = async (task: () => Promise<unknown>, notice: string) => {
    if (busy) return; setBusy(true);
    try { await task(); setSaved(notice); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const persistRemark = async () => {
    await bridge.mutate({ type: "remark", id: entry.id, value: remark }); setSavedRemark(remark);
    await recovery.write(text, remark, savedText, remark); if (text === savedText) onRecoveryCleared();
  };
  const persistCopy = async () => {
    const result = await bridge.mutate({ type: "edit-copy", id: entry.id, text });
    if (!result?.id) throw new Error(tr("未收到新记录标识，请刷新后检查保存结果。"));
    setSavedText(text);
    await recovery.clear(); onRecoveryCleared();
    await onCreated(result.id); setEditing(false);
  };
  const saveRemark = () => run(persistRemark, tr("备注已保存"));
  const saveCopy = () => run(async () => { if (remark !== savedRemark) await persistRemark(); await persistCopy(); }, tr("已保存为新记录，原记录保留"));
  useEffect(() => {
    onDraft({ dirty: busy || recovery.state === "writing" || recovery.state === "failed" || remark !== savedRemark || text !== savedText, busy,
      save: async () => {
        if (busy) throw new Error(tr("正在保存，请稍后再试。"));
        setBusy(true);
        try { if (remark !== savedRemark) await persistRemark(); if (text !== savedText) await persistCopy(); else if (remark === savedRemark) { await recovery.clear(); onRecoveryCleared(); } onChanged(); }
        finally { setBusy(false); }
      },
      discard: async () => { await recovery.clear(); onRecoveryCleared(); setRemark(savedRemark); setText(savedText); setEditing(false); },
    });
    return () => onDraft(null);
  });
  return <article className={styles.preview} aria-label={tr("剪贴板预览")} onFocus={onInteract}>
    {recovered && recovered.baseRemark !== entry.remark && recovered.remark !== entry.remark ? <p className={styles.muted}>{tr("原记录的备注已更新，保存这份草稿会覆盖当前备注。")}</p> : null}
    <header className={styles.previewHeader}><strong>{entry.title}</strong><span className={styles.typeLabel}>{entry.kind === "image" ? tr("图片") : entry.kind === "files" ? tr("文件") : entry.kind === "link" ? tr("链接") : tr("文字")}</span><button className={styles.iconButton} disabled={busy} aria-label={entry.starred ? tr("取消收藏") : tr("收藏")} title={entry.starred ? tr("取消收藏") : tr("收藏")} aria-pressed={entry.starred} onClick={() => void run(() => bridge.mutate({ type: "star", ids: [entry.id], value: !entry.starred }), entry.starred ? tr("已取消收藏") : tr("已收藏"))}><AliIcon name="bookmark" size={20} /></button></header>
    <div className={styles.metadata}><span>{entry.source.name || tr("来源未知")} · {new Date(entry.copiedAt).toLocaleString(locale)}</span><span>{entry.copies} {tr("次复制")}</span></div>
    <div className={styles.contentFacts} aria-label={tr("内容信息")}>
      {metrics && entry.kind !== "files" && entry.kind !== "image" ? <span>{metrics.characters.toLocaleString(locale)} {tr("字符 ·")} {metrics.lines.toLocaleString(locale)} {tr("行")}</span> : null}
      {entry.image ? <span>{entry.image.width} × {entry.image.height} · {clipboardByteLabel(entry.image.bytes)}</span> : entry.kind === "files" ? <span>{entry.files.length} {tr("个文件或文件夹")}</span> : <span>{clipboardByteLabel(entry.bytes)}</span>}
      {link ? <button disabled={busy} title={link.url} aria-label={tr("在浏览器打开 {hostname}", { hostname: link.hostname })} onClick={() => void run(() => bridge.openLink(entry.id), tr("已请求在浏览器打开"))}><AliIcon name="link" size={14} />{link.hostname}</button> : null}
    </div>
    {entry.kind === "image" ? <div className={styles.previewTools}><button onClick={() => setZoom(0)}>{tr("适应窗口")}</button><button onClick={() => setZoom(1)}>100%</button><select aria-label={tr("图片缩放")} value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={0}>{tr("适应")}</option><option value={0.5}>50%</option><option value={1}>100%</option><option value={2}>200%</option></select></div> : null}
    <div className={styles.previewContent}>
      {editing ? <textarea aria-label={tr("编辑剪贴板副本")} value={text} disabled={busy} onChange={event => updateDraft(event.target.value, remark)} spellCheck={false} /> : entry.kind === "image" ? <div className={styles.imageCanvas} data-fit={zoom === 0} style={zoom ? { width: Math.max(1, (entry.image?.width ?? 1) * zoom), height: Math.max(1, (entry.image?.height ?? 1) * zoom) } : undefined}><ClipboardImage bridge={bridge} id={entry.id} title={entry.title} /></div> : entry.kind === "files" ? <ul className={styles.files}>{entry.files.map((file, index) => <li key={file.path}><strong><AliIcon name={file.directory ? "folder" : "file"} size={16} /> {file.name}</strong><small>{file.directory ? tr("文件夹") : file.name.includes(".") ? tr("{type} 文件", { type: file.name.split(".").pop()?.toUpperCase() ?? "" }) : tr("文件")} · {file.path}</small><button disabled={!file.exists} onClick={() => void run(() => bridge.revealFile(entry.id, index), "")}>{file.exists ? tr("定位文件") : tr("文件已不存在")}</button></li>)}</ul> : rich && entry.html ? <iframe title={tr("富文本预览")} sandbox="" referrerPolicy="no-referrer" srcDoc={richDocument} /> : <pre>{entry.text ?? tr("没有纯文本表示。已保存的富格式仍可复制使用。")}</pre>}
    </div>
    <div className={styles.previewTools}><div className={styles.formatTabs}>{entry.text !== null ? <button aria-label={tr("查看纯文本")} aria-pressed={!rich} onClick={() => setRich(false)}>{tr("纯文本")}</button> : null}{entry.html ? <button aria-label={rich ? tr("查看纯文本") : tr("查看格式")} aria-pressed={rich} onClick={() => setRich(!rich)}>HTML</button> : entry.rtf ? <span className={styles.typeLabel}>RTF</span> : null}{entry.kind === "image" ? <span className={styles.typeLabel}>PNG</span> : null}</div><span className={styles.spacer} />{entry.text !== null ? <button aria-pressed={editing} onClick={() => setEditing(!editing)}><AliIcon name="compose" size={15} />{editing ? tr("返回预览") : tr("编辑为新记录")}</button> : null}</div>
    <div className={styles.remark}><AliIcon name="comment" size={17} /><input aria-label={tr("剪贴板备注")} placeholder={tr("添加备注，方便下次找到")} maxLength={1000} value={remark} disabled={busy} onChange={event => updateDraft(text, event.target.value)} />{remark !== savedRemark ? <button disabled={busy} onClick={() => void saveRemark()}>{tr("保存备注")}</button> : null}</div>
    <div className={styles.previewTools}>{editing ? <button className={styles.primary} disabled={busy} onClick={() => void saveCopy()}>{tr("保存新记录")}</button> : null}<button disabled={busy || entry.text === null && entry.kind !== "image"} onClick={() => void run(() => bridge.saveAs(entry.id), "")}><AliIcon name="file" size={15} />{tr("另存为…")}</button>{onSave ? <button disabled={busy} onClick={() => void run(() => onSave(entry), tr("已存入中转站"))}><AliIcon name="archive" size={15} />{tr("存入中转站")}</button> : null}</div>
    {entry.rtf && !entry.html ? <span className={styles.muted}>{tr("RTF 原格式已保留；这里显示纯文本，普通粘贴仍使用原格式。")}</span> : null}
    {recovery.state !== "idle" ? <span role="status" className={styles.muted}>{recovery.state === "writing" ? tr("正在保留编辑草稿…") : recovery.state === "saved" ? tr("编辑草稿已保留在本机") : <>{tr("草稿尚未写入本机，请重试后再关闭窗口。")} <button onClick={() => void recovery.retry().catch(onError)}>{tr("重试保存草稿")}</button></>}</span> : null}
    {saved ? <span role="status" className={styles.muted}>{saved}</span> : null}
  </article>;
}
