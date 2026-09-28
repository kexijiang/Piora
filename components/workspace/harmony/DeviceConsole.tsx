"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";

type Entry = { command: string; stdout: string; stderr: string; exitCode?: number; durationMs?: number; error?: string };
type ConsoleTab = { id: number; label: string; draft: string; entries: Entry[] };

export function DeviceConsole({ serial, chinese, canControl, ensureControl }: { serial: string; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string> }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [tabs, setTabs] = useState<ConsoleTab[]>([{ id: 1, label: "1", draft: "", entries: [] }]);
  const [activeId, setActiveId] = useState(1), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared"), [bundleName, setBundleName] = useState("");
  const nextId = useRef(1), controller = useRef<AbortController | null>(null);
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0];
  useEffect(() => () => controller.current?.abort(), []);
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
    <p>{copy("手动执行单次 HDC shell 命令，每次最多 15 秒、128 KiB 输出。标签保留本页记录，但每条命令都开启新 Shell；cd 和环境变量不会延续。取消后设备端副作用可能仍需手动核对。", "Run one HDC shell command at a time (15 seconds, 128 KiB output). Tabs retain page history, but each command starts a new shell; cd and environment changes do not persist. Check device effects after cancellation.")}</p>
    <div role="tablist" aria-label={copy("命令标签", "Command tabs")}>{tabs.map(tab => <span key={tab.id}>
      <button role="tab" aria-selected={activeId === tab.id} onClick={() => setActiveId(tab.id)}>{tab.label}</button>
      {tabs.length > 1 ? <button disabled={busy} aria-label={copy(`关闭标签 ${tab.label}`, `Close tab ${tab.label}`)} onClick={() => { setTabs(current => current.filter(item => item.id !== tab.id)); if (activeId === tab.id) setActiveId(tabs.find(item => item.id !== tab.id)!.id); }}>×</button> : null}
    </span>)}<button disabled={busy || tabs.length >= 8} onClick={() => { const id = ++nextId.current; setTabs(current => [...current, { id, label: String(id), draft: "", entries: [] }]); setActiveId(id); }}>+</button></div>
    <label>{copy("范围", "Scope")}<select value={kind} onChange={event => setKind(event.target.value as HarmonyFileScope["kind"])}><option value="shared">{copy("设备 Shell", "Device shell")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></label>
    {kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}
    <label>{copy("命令（Ctrl+Enter 执行）", "Command (Ctrl+Enter to run)")}<textarea rows={3} maxLength={8192} style={{ width: "100%" }} value={active?.draft ?? ""} onChange={event => updateTab(activeId, tab => ({ ...tab, draft: event.target.value }))} onKeyDown={event => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void execute(); } }} /></label>
    <button disabled={busy || !canControl || !active?.draft.trim() || (kind === "sandbox" && !bundleName.trim())} onClick={() => void execute()}>{copy("执行", "Run")}</button>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    <button disabled={busy || !active?.entries.length} onClick={() => updateTab(activeId, tab => ({ ...tab, entries: [] }))}>{copy("清空当前记录", "Clear tab history")}</button>
    <div role="log" aria-live="polite">{active?.entries.map((entry, index) => <article key={index}>
      <strong>$ {entry.command}</strong><span> · {entry.exitCode === undefined ? copy("未确认完成", "Unconfirmed") : `exit ${entry.exitCode} · ${entry.durationMs} ms`}</span>
      {entry.stdout ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 300, overflow: "auto" }}>{entry.stdout}</pre> : null}
      {entry.stderr ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflow: "auto" }}>{entry.stderr}</pre> : null}
      {entry.error ? <p role="alert">{entry.error}</p> : null}
    </article>)}</div>
  </section>;
}
