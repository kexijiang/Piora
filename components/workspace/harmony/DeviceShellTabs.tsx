"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { InteractiveDeviceShell } from "./InteractiveDeviceShell";

type Status = "idle" | "connecting" | "connected" | "disconnected";
type Tab = { id: number; label: string };
type Output = { id: number; label: string; output: string };
interface Props {
  serial: string; scope: HarmonyFileScope; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>;
  onOutputsChange?: (outputs: Output[]) => void; searchTarget?: { tabId: number; query: string; revision: number };
}

export function DeviceShellTabs({ serial, scope, chinese, canControl, ensureControl, onOutputsChange, searchTarget }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, label: "1" }]);
  const [activeId, setActiveId] = useState(1);
  const [statuses, setStatuses] = useState<Record<number, Status>>({});
  const nextId = useRef(1), outputs = useRef(new Map<number, string>());
  const currentTabs = useRef(tabs); currentTabs.current = tabs;
  const listener = useRef(onOutputsChange); listener.current = onOutputsChange;
  const prefix = useId();
  const pendingFocus = useRef<number | null>(null);
  const searchTabId = searchTarget?.tabId;
  const searchRevision = searchTarget?.revision;
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const handlers = useRef(new Map<number, { output(value: string): void; status(value: Status): void }>());
  const getHandlers = (id: number) => {
    let handler = handlers.current.get(id);
    if (!handler) {
      handler = {
        output(value) {
          if (!currentTabs.current.some(item => item.id === id)) return;
          outputs.current.set(id, value);
          listener.current?.(currentTabs.current.map(item => ({ id: item.id, label: item.label, output: outputs.current.get(item.id) ?? "" })));
        },
        status(value) {
          if (currentTabs.current.some(item => item.id === id)) setStatuses(current => current[id] === value ? current : { ...current, [id]: value });
        },
      };
      handlers.current.set(id, handler);
    }
    return handler;
  };
  useEffect(() => { onOutputsChange?.(tabs.map(tab => ({ id: tab.id, label: tab.label, output: outputs.current.get(tab.id) ?? "" }))); }, [onOutputsChange, tabs]);
  useEffect(() => { if (searchTabId !== undefined && currentTabs.current.some(tab => tab.id === searchTabId)) setActiveId(searchTabId); }, [searchTabId, searchRevision]);
  useEffect(() => {
    if (pendingFocus.current !== null) {
      document.getElementById(`${prefix}-tab-${pendingFocus.current}`)?.focus();
      pendingFocus.current = null;
    }
  }, [tabs, prefix]);
  const close = (id: number) => {
    if (tabs.length === 1) return;
    const remaining = tabs.filter(tab => tab.id !== id);
    outputs.current.delete(id);
    handlers.current.delete(id);
    setStatuses(current => { const next = { ...current }; delete next[id]; return next; });
    pendingFocus.current = activeId === id ? remaining[0].id : activeId;
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  };
  return <section aria-label={copy("设备 Shell 标签", "Device shell tabs")}>
    <div role="tablist" aria-label={copy("交互式 Shell 标签", "Interactive shell tabs")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {tabs.map(tab => <span key={tab.id} style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6 }}>
        <button id={`${prefix}-tab-${tab.id}`} role="tab" aria-controls={`${prefix}-panel-${tab.id}`} aria-selected={activeId === tab.id} tabIndex={activeId === tab.id ? 0 : -1} onClick={() => setActiveId(tab.id)} onKeyDown={event => {
          const index = tabs.findIndex(item => item.id === tab.id);
          const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
          if (nextIndex === undefined) return;
          event.preventDefault(); const next = tabs[nextIndex]; setActiveId(next.id); document.getElementById(`${prefix}-tab-${next.id}`)?.focus();
        }}>
          Shell {tab.label} · {statuses[tab.id] === "connected" ? copy("已连接", "Connected") : statuses[tab.id] === "connecting" ? copy("连接中", "Connecting") : statuses[tab.id] === "disconnected" ? copy("已断开", "Disconnected") : copy("未连接", "Not connected")}
        </button>
        {tabs.length > 1 ? <button aria-label={copy(`关闭设备 Shell 标签 ${tab.label}`, `Close device shell tab ${tab.label}`)} onClick={() => close(tab.id)}>×</button> : null}
      </span>)}
      <button disabled={!canControl || tabs.length >= 8 || scope.kind === "sandbox" && !scope.bundleName.trim()} onClick={() => {
        const id = ++nextId.current;
        setTabs(current => [...current, { id, label: String(id) }]); setActiveId(id);
      }}>{copy("新建设备 Shell 标签", "New device shell tab")}</button>
    </div>
    {tabs.map(tab => <div key={tab.id} id={`${prefix}-panel-${tab.id}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${tab.id}`} hidden={activeId !== tab.id}>
      <InteractiveDeviceShell serial={serial} scope={scope} chinese={chinese} canControl={canControl} ensureControl={ensureControl}
        clientTerminalId={`${prefix}:${tab.id}`} visible={activeId === tab.id}
        onOutputChange={getHandlers(tab.id).output} onStatusChange={getHandlers(tab.id).status}
        searchTarget={searchTarget?.tabId === tab.id ? searchTarget : undefined} />
    </div>)}
  </section>;
}
