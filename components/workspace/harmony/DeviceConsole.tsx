"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { InteractiveDeviceShell } from "./InteractiveDeviceShell";

type Entry = { command: string; stdout: string; stderr: string; exitCode?: number; durationMs?: number; error?: string };
type ConsoleTab = { id: number; label: string; draft: string; entries: Entry[] };
type Shortcut = { id: string; name: string; command: string; kind: HarmonyFileScope["kind"]; bundleName?: string };

export function DeviceConsole({ serial, chinese, canControl, ensureControl, onOpenLocalTerminal, visible }: { serial: string; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>; onOpenLocalTerminal?: () => void; visible: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [tabs, setTabs] = useState<ConsoleTab[]>([{ id: 1, label: "1", draft: "", entries: [] }]);
  const [activeId, setActiveId] = useState(1), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared"), [bundleName, setBundleName] = useState("");
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]), [shortcutName, setShortcutName] = useState("");
  const shortcutKey = `piora-harmony-command-shortcuts:${serial}`;
  const nextId = useRef(1), controller = useRef<AbortController | null>(null);
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0];
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { try {
    const saved = JSON.parse(localStorage.getItem(shortcutKey) ?? "[]");
    setShortcuts(Array.isArray(saved) ? saved.filter((item): item is Shortcut => item && typeof item.id === "string" && typeof item.name === "string"
      && typeof item.command === "string" && (item.kind === "shared" || item.kind === "sandbox") && item.command.length <= 8192).slice(0, 20) : []);
  } catch { setShortcuts([]); } }, [shortcutKey]);
  const saveShortcuts = (next: Shortcut[]) => { setShortcuts(next); try { localStorage.setItem(shortcutKey, JSON.stringify(next)); } catch { /* Local storage can be unavailable. */ } };
  const updateTab = (id: number, patch: (tab: ConsoleTab) => ConsoleTab) => setTabs(current => current.map(tab => tab.id === id ? patch(tab) : tab));
  const execute = async () => {
    if (busy || !canControl || !active?.draft.trim() || (kind === "sandbox" && !bundleName.trim())) return;
    const id = active.id, command = active.draft;
    const current = new AbortController(); controller.current = current; setBusy(true);
    updateTab(id, tab => ({ ...tab, draft: "" }));
    let dispatched = false;
    try {
      const leaseToken = await ensureControl();
      if (current.signal.aborted) { updateTab(id, tab => ({ ...tab, draft: command })); return; }
      dispatched = true;
      const response = await fetch("/api/harmony/console", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ serial, leaseToken, kind, ...(kind === "sandbox" ? { bundleName } : {}), command }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      const result = data.result as { stdout: string; stderr: string; exitCode: number; durationMs: number };
      updateTab(id, tab => ({ ...tab, entries: [...tab.entries, { command, ...result }].slice(-100) }));
    } catch (error) {
      if (!dispatched && current.signal.aborted) updateTab(id, tab => ({ ...tab, draft: command }));
      else updateTab(id, tab => ({ ...tab, entries: [...tab.entries, { command, stdout: "", stderr: "", error: current.signal.aborted
        ? copy("已请求取消；设备端效果未确认。", "Cancellation requested; device effect is unconfirmed.")
        : error instanceof Error ? error.message : String(error) }].slice(-100) }));
    } finally { if (controller.current === current) setBusy(false); }
  };
  return <section aria-label={copy("设备命令", "Device commands")}>
    <h3>{copy("设备命令", "Device commands")}</h3>
    {onOpenLocalTerminal ? <button onClick={onOpenLocalTerminal}>{copy("打开本机终端", "Open local terminal")}</button> : null}
    <p>{copy("可使用下方交互式设备 Shell，或执行单次 HDC 命令（最多 15 秒、128 KiB 输出）。单次命令不保留 cd 和环境变量；取消后设备端副作用可能仍需核对。", "Use the interactive device shell below, or run one HDC command (15 seconds, 128 KiB output). One-shot commands do not preserve cd or environment changes; verify device effects after cancellation.")}</p>
    <div role="tablist" aria-label={copy("命令标签", "Command tabs")}>{tabs.map(tab => <span key={tab.id}>
      <button role="tab" aria-selected={activeId === tab.id} onClick={() => setActiveId(tab.id)}>{tab.label}</button>
      {tabs.length > 1 ? <button disabled={busy} aria-label={copy(`关闭标签 ${tab.label}`, `Close tab ${tab.label}`)} onClick={() => { setTabs(current => current.filter(item => item.id !== tab.id)); if (activeId === tab.id) setActiveId(tabs.find(item => item.id !== tab.id)!.id); }}>×</button> : null}
    </span>)}<button disabled={busy || tabs.length >= 8} onClick={() => { const id = ++nextId.current; setTabs(current => [...current, { id, label: String(id), draft: "", entries: [] }]); setActiveId(id); }}>+</button></div>
    <label>{copy("范围", "Scope")}<select value={kind} onChange={event => setKind(event.target.value as HarmonyFileScope["kind"])}><option value="shared">{copy("设备 Shell", "Device shell")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></label>
    {kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}
    <label>{copy("命令（Ctrl+Enter 执行）", "Command (Ctrl+Enter to run)")}<textarea rows={3} maxLength={8192} style={{ width: "100%" }} value={active?.draft ?? ""} onChange={event => updateTab(activeId, tab => ({ ...tab, draft: event.target.value }))} onKeyDown={event => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void execute(); } }} /></label>
    <details><summary>{copy("快捷命令", "Command shortcuts")}</summary>
      <p>{copy("快捷命令保存在这台电脑的浏览器存储中；点击只会填入输入框。", "Shortcuts are saved in this computer's browser storage; selecting one only fills the command box.")}</p>
      <label>{copy("快捷命令名称", "Shortcut name")}<input value={shortcutName} maxLength={60} onChange={event => setShortcutName(event.target.value)} /></label>
      <button disabled={busy || shortcuts.length >= 20 || !shortcutName.trim() || !active?.draft.trim()} onClick={() => { saveShortcuts([...shortcuts, { id: crypto.randomUUID(), name: shortcutName.trim(), command: active.draft, kind, ...(kind === "sandbox" ? { bundleName } : {}) }]); setShortcutName(""); }}>{copy("保存当前命令", "Save current command")}</button>
      <ul>{shortcuts.map(shortcut => <li key={shortcut.id}><button disabled={busy} onClick={() => { updateTab(activeId, tab => ({ ...tab, draft: shortcut.command })); setKind(shortcut.kind); setBundleName(shortcut.bundleName ?? ""); }}>{shortcut.name}</button>
        <button disabled={busy} aria-label={copy(`删除快捷命令 ${shortcut.name}`, `Delete shortcut ${shortcut.name}`)} onClick={() => saveShortcuts(shortcuts.filter(item => item.id !== shortcut.id))}>×</button></li>)}</ul>
    </details>
    <button disabled={busy || !canControl || !active?.draft.trim() || (kind === "sandbox" && !bundleName.trim())} onClick={() => void execute()}>{copy("执行", "Run")}</button>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    <button disabled={busy || !active?.entries.length} onClick={() => updateTab(activeId, tab => ({ ...tab, entries: [] }))}>{copy("清空当前记录", "Clear tab history")}</button>
    <div role="log" aria-live="polite">{active?.entries.map((entry, index) => <article key={index}>
      <strong>$ {entry.command}</strong><span> · {entry.exitCode === undefined ? copy("未确认完成", "Unconfirmed") : `exit ${entry.exitCode} · ${entry.durationMs} ms`}</span>
      {entry.stdout ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 300, overflow: "auto" }}>{entry.stdout}</pre> : null}
      {entry.stderr ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflow: "auto" }}>{entry.stderr}</pre> : null}
      {entry.error ? <p role="alert">{entry.error}</p> : null}
    </article>)}</div>
    {visible ? <InteractiveDeviceShell key={`${serial}:${kind}:${bundleName}`} serial={serial} scope={kind === "sandbox" ? { kind, bundleName } : { kind }}
      chinese={chinese} canControl={canControl} ensureControl={ensureControl} /> : null}
  </section>;
}
