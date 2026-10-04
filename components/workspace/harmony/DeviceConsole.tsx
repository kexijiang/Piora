"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { DeviceShellTabs } from "./DeviceShellTabs";
import { CommandShortcuts } from "./CommandShortcuts";
import { SmartShellPanel } from "../SmartShellPanel";
import { terminalSearchMatch } from "@/lib/harmony/terminal-search";
import { readClipboardText, copyText } from "@/lib/clipboard";

type Entry = { command: string; stdout: string; stderr: string; exitCode?: number; durationMs?: number; error?: string };
type ConsoleTab = { id: number; label: string; draft: string; entries: Entry[] };
type SearchMatch = { kind: "command"; tabId: number; tabLabel: string; entryIndex: number; command: string; excerpt: string }
  | { kind: "device"; tabId: number; label: string; excerpt: string }
  | { kind: "local"; sessionId: string; label: string; excerpt: string };

export function DeviceConsole({ serial, chinese, canControl, ensureControl, onOpenLocalTerminal, visible, cwd }: { serial: string; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>; onOpenLocalTerminal?: () => void; visible: boolean; cwd?: string | null }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [tabs, setTabs] = useState<ConsoleTab[]>([{ id: 1, label: "1", draft: "", entries: [] }]);
  const [activeId, setActiveId] = useState(1), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared"), [bundleName, setBundleName] = useState("");
  const [splitLocal, setSplitLocal] = useState(false);
  const [searchText, setSearchText] = useState(""), [searchTerm, setSearchTerm] = useState("");
  const [deviceOutputs, setDeviceOutputs] = useState<{ id: number; label: string; output: string }[]>([]);
  const [localOutputs, setLocalOutputs] = useState<{ id: string; label: string; output: string }[]>([]);
  const [localSearchError, setLocalSearchError] = useState(""), [searchingLocal, setSearchingLocal] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [deviceSearchTarget, setDeviceSearchTarget] = useState<{ tabId: number; query: string; revision: number }>();
  const [localSearchTarget, setLocalSearchTarget] = useState<{ sessionId: string; query: string; revision: number }>();
  const [clipboardMessage, setClipboardMessage] = useState("");
  const [selectedMatch, setSelectedMatch] = useState<{ tabId: number; entryIndex: number }>();
  const logId = useId();
  const nextId = useRef(1), searchTargetSequence = useRef(0), controller = useRef<AbortController | null>(null);
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0];
  const matches = useMemo<SearchMatch[]>(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return [];
    const found: SearchMatch[] = [];
    for (const tab of deviceOutputs) {
      const deviceMatch = terminalSearchMatch(tab.output, query);
      if (deviceMatch) found.push({ kind: "device", tabId: tab.id, label: tab.label, excerpt: deviceMatch.excerpt });
    }
    for (const session of localOutputs) {
      const match = terminalSearchMatch(session.output, query);
      if (match) found.push({ kind: "local", sessionId: session.id, label: session.label, excerpt: match.excerpt });
      if (found.length >= 100) return found;
    }
    for (const tab of tabs) for (let entryIndex = 0; entryIndex < tab.entries.length; entryIndex++) {
      const entry = tab.entries[entryIndex];
      for (const content of [entry.command, entry.stdout, entry.stderr, entry.error ?? ""]) {
        const match = content.toLocaleLowerCase().indexOf(query);
        if (match < 0) continue;
        const start = Math.max(0, match - 36), end = Math.min(content.length, match + query.length + 64);
        found.push({ kind: "command", tabId: tab.id, tabLabel: tab.label, entryIndex, command: entry.command,
          excerpt: `${start ? "…" : ""}${content.slice(start, end).replaceAll(/\s+/g, " ")}${end < content.length ? "…" : ""}` });
        break;
      }
      if (found.length >= 100) return found;
    }
    return found;
  }, [searchTerm, tabs, deviceOutputs, localOutputs]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { const timer = window.setTimeout(() => setSearchTerm(searchText), 150); return () => window.clearTimeout(timer); }, [searchText]);
  useEffect(() => {
    const query = searchTerm.trim();
    if (!query || !cwd) { setLocalOutputs([]); setLocalSearchError(""); setSearchingLocal(false); return; }
    const controller = new AbortController();
    const load = async () => {
      setSearchingLocal(true); setLocalSearchError(""); setLocalOutputs([]);
      try {
        const response = await fetch(`/api/shell/sessions?cwd=${encodeURIComponent(cwd)}&native=true`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const inventory = await response.json() as { sessions: { id: string; profile: { label: string } }[] };
        const found: { id: string; label: string; output: string }[] = [];
        for (let index = 0; index < inventory.sessions.length; index += 4) {
          const batch = inventory.sessions.slice(index, index + 4);
          const outputs = await Promise.all(batch.map(async session => {
            const item = await fetch(`/api/shell/sessions/${encodeURIComponent(session.id)}`, { signal: controller.signal });
            if (!item.ok) throw new Error(`HTTP ${item.status}`);
            const snapshot = await item.json() as { output: string };
            return { id: session.id, label: session.profile.label, output: snapshot.output };
          }));
          found.push(...outputs);
        }
        if (!controller.signal.aborted) setLocalOutputs(found);
      } catch (cause) {
        if (!controller.signal.aborted) setLocalSearchError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!controller.signal.aborted) setSearchingLocal(false); }
    };
    void load();
    return () => controller.abort();
  }, [cwd, searchTerm, searchRevision]);
  useEffect(() => {
    if (!selectedMatch || selectedMatch.tabId !== activeId) return;
    document.getElementById(`${logId}-${selectedMatch.tabId}-${selectedMatch.entryIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, logId, selectedMatch]);
  const copyToClipboard = async (value: string) => {
    try { await copyText(value); setClipboardMessage(copy("已复制到剪贴板", "Copied to clipboard")); }
    catch (cause) { setClipboardMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const pasteIntoDraft = async () => {
    try {
      const value = await readClipboardText();
      updateTab(activeId, tab => ({ ...tab, draft: `${tab.draft}${value}`.slice(0, 8192) }));
      setClipboardMessage(copy("已粘贴到命令草稿，请检查后手动执行", "Pasted into the draft. Review before running."));
    } catch (cause) { setClipboardMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
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
    {cwd ? <button aria-pressed={splitLocal} onClick={() => setSplitLocal(value => !value)}>{splitLocal ? copy("收起本机分屏", "Close local split") : copy("设备与本机分屏", "Split device and local terminals")}</button> : null}
    <p>{copy("可使用下方交互式设备 Shell，或执行单次 HDC 命令（最多 15 秒、128 KiB 输出）。单次命令不保留 cd 和环境变量；取消后设备端副作用可能仍需核对。", "Use the interactive device shell below, or run one HDC command (15 seconds, 128 KiB output). One-shot commands do not preserve cd or environment changes; verify device effects after cancellation.")}</p>
    <div role="tablist" aria-label={copy("命令标签", "Command tabs")}>{tabs.map(tab => <span key={tab.id}>
      <button role="tab" aria-selected={activeId === tab.id} onClick={() => setActiveId(tab.id)}>{tab.label}</button>
      {tabs.length > 1 ? <button disabled={busy} aria-label={copy(`关闭标签 ${tab.label}`, `Close tab ${tab.label}`)} onClick={() => { setTabs(current => current.filter(item => item.id !== tab.id)); if (activeId === tab.id) setActiveId(tabs.find(item => item.id !== tab.id)!.id); }}>×</button> : null}
    </span>)}<button disabled={busy || tabs.length >= 8} onClick={() => { const id = ++nextId.current; setTabs(current => [...current, { id, label: String(id), draft: "", entries: [] }]); setActiveId(id); }}>+</button></div>
    <label>{copy("搜索命令、设备与本机终端", "Search commands, device and local terminals")}<input value={searchText} maxLength={120} onChange={event => setSearchText(event.target.value)} /></label>
    {searchText.trim() ? <div role="group" aria-label={copy("统一终端搜索结果", "Unified terminal search results")}>
      {cwd ? <button onClick={() => setSearchRevision(value => value + 1)}>{copy("刷新本机终端结果", "Refresh local terminal results")}</button> : null}
      {searchingLocal ? <span role="status">{copy("正在搜索本机终端…", "Searching local terminals…")}</span> : null}
      {localSearchError ? <p role="alert">{copy("本机终端搜索失败：", "Local terminal search failed: ")}{localSearchError}</p> : null}
      <p role="status">{copy(`找到 ${matches.length} 条${matches.length === 100 ? "（最多显示 100 条）" : ""}`, `${matches.length} matches${matches.length === 100 ? " (showing up to 100)" : ""}`)}</p>
      <ul>{matches.map(match => <li key={match.kind === "command" ? `command-${match.tabId}-${match.entryIndex}` : match.kind === "local" ? `local-${match.sessionId}` : `device-${match.tabId}`}><button onClick={() => {
        if (match.kind === "command") { setActiveId(match.tabId); setSelectedMatch({ tabId: match.tabId, entryIndex: match.entryIndex }); }
        else if (match.kind === "device") setDeviceSearchTarget({ tabId: match.tabId, query: searchTerm.trim(), revision: ++searchTargetSequence.current });
        else { setSplitLocal(true); setLocalSearchTarget({ sessionId: match.sessionId, query: searchTerm.trim(), revision: ++searchTargetSequence.current }); }
      }}>
        {match.kind === "command" ? `${copy("标签", "Tab")} ${match.tabLabel} · ${match.command.slice(0, 80)}` : match.kind === "device" ? `${copy("设备 Shell", "Device shell")} ${match.label}` : `${copy("本机终端", "Local terminal")} ${match.label}`} · {match.excerpt}
      </button></li>)}</ul>
    </div> : null}
    <label>{copy("范围", "Scope")}<select aria-label={copy("范围", "Scope")} value={kind} onChange={event => setKind(event.target.value as HarmonyFileScope["kind"])}><option value="shared">{copy("设备 Shell", "Device shell")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></label>
    {kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}
    <label>{copy("命令（Ctrl+Enter 执行）", "Command (Ctrl+Enter to run)")}<textarea rows={3} maxLength={8192} style={{ width: "100%" }} value={active?.draft ?? ""} onChange={event => updateTab(activeId, tab => ({ ...tab, draft: event.target.value }))} onKeyDown={event => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void execute(); } }} /></label>
    <button onClick={() => void pasteIntoDraft()}>{copy("从剪贴板粘贴到草稿", "Paste clipboard into draft")}</button>
    {clipboardMessage ? <p role="status">{clipboardMessage}</p> : null}
    <CommandShortcuts key={serial} serial={serial} chinese={chinese} busy={busy} currentCommand={active?.draft ?? ""} currentKind={kind} currentBundleName={bundleName}
      onFillDevice={(command, nextKind, nextBundleName) => { updateTab(activeId, tab => ({ ...tab, draft: command })); setKind(nextKind); setBundleName(nextBundleName); }}
      onOpenLocalTerminal={onOpenLocalTerminal} />
    <button disabled={busy || !canControl || !active?.draft.trim() || (kind === "sandbox" && !bundleName.trim())} onClick={() => void execute()}>{copy("执行", "Run")}</button>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    <button disabled={busy || !active?.entries.length} onClick={() => updateTab(activeId, tab => ({ ...tab, entries: [] }))}>{copy("清空当前记录", "Clear tab history")}</button>
    <div role="log" aria-live="polite">{active?.entries.map((entry, index) => <article id={`${logId}-${active.id}-${index}`} key={index}>
      <strong>$ {entry.command}</strong><span> · {entry.exitCode === undefined ? copy("未确认完成", "Unconfirmed") : `exit ${entry.exitCode} · ${entry.durationMs} ms`}</span>
      <button onClick={() => void copyToClipboard(entry.command)}>{copy("复制命令", "Copy command")}</button>
      {entry.stdout ? <button onClick={() => void copyToClipboard(entry.stdout)}>{copy("复制标准输出", "Copy standard output")}</button> : null}
      {entry.stderr ? <button onClick={() => void copyToClipboard(entry.stderr)}>{copy("复制错误输出", "Copy error output")}</button> : null}
      {entry.error ? <button onClick={() => void copyToClipboard(entry.error!)}>{copy("复制失败原因", "Copy failure reason")}</button> : null}
      {entry.stdout ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 300, overflow: "auto" }}>{entry.stdout}</pre> : null}
      {entry.stderr ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflow: "auto" }}>{entry.stderr}</pre> : null}
      {entry.error ? <p role="alert">{entry.error}</p> : null}
    </article>)}</div>
    {visible ? <div style={{ display: "grid", gridTemplateColumns: splitLocal && cwd ? "repeat(auto-fit, minmax(min(100%, 370px), 1fr))" : "minmax(0, 1fr)", gap: 12 }}>
      <DeviceShellTabs key={`${serial}:${kind}:${bundleName}`} serial={serial} scope={kind === "sandbox" ? { kind, bundleName } : { kind }}
        chinese={chinese} canControl={canControl} ensureControl={ensureControl} onOutputsChange={searchText.trim() ? setDeviceOutputs : undefined} searchTarget={deviceSearchTarget} />
      {splitLocal && cwd ? <div aria-label={copy("本机终端分屏", "Local terminal split")} style={{ height: 400, minWidth: 0, border: "1px solid var(--border)" }}><SmartShellPanel cwd={cwd} searchTarget={localSearchTarget} /></div> : null}
    </div> : null}
  </section>;
}
