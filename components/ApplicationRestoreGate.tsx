"use client";
import { useEffect, useState } from "react";
import { restoreClientBackup, type ClientBackup } from "@/lib/app-backup-client";

function remapClient(snapshot: ClientBackup, mappings: Array<{ from: string; to: string }>): ClientBackup {
  function remap(value: string) {
    for (const { from, to } of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
      const src = from.replace(/\\/g, "/").replace(/\/$/, ""), str = value.replace(/\\/g, "/");
      const insensitive = /^[a-z]:/i.test(src), left = insensitive ? str.toLowerCase() : str, right = insensitive ? src.toLowerCase() : src;
      if (left === right) return to;
      if (left.startsWith(right + "/")) return to.replace(/[\\/]$/, "") + (to.includes("\\") ? "\\" : "/") + str.slice(src.length + 1).replace(/\//g, to.includes("\\") ? "\\" : "/");
    } return value;
  }
  function uiValue(value: unknown): unknown { if (typeof value === "string") return remap(value); if (Array.isArray(value)) return value.map(uiValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, value]) => [remap(key), uiValue(value)])); return value; }
  const local = Object.fromEntries(Object.entries(snapshot.local).map(([key, value]) => {
    if (/draft|json-workbench|markdown|prompt-recovery/i.test(key)) return [key, value];
    try { return [remap(key), JSON.stringify(uiValue(JSON.parse(value)))]; } catch { return [remap(key), remap(value)]; }
  }));
  return { ...snapshot, local, drafts: snapshot.drafts.map(([key, draft]) => [key.startsWith("new:") ? `new:${remap(key.slice(4))}` : remap(key), draft]), databases: snapshot.databases.map((database) => database.name !== "piora-prompt-recovery" ? database : { ...database, records: database.records.map((value) => { const record = value as Record<string, unknown>; return { ...record, scope: typeof record.scope === "string" && record.scope.startsWith("new:") ? `new:${remap(record.scope.slice(4))}` : record.scope }; }) }) };
}
let startup: Promise<boolean> | undefined;
async function restore() {
  const response = await fetch("/api/settings/backup?action=client", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { id: string; state: ClientBackup; mappings: Array<{ from: string; to: string }> } | null;
  if (!payload || localStorage.getItem("piora-transfer-applied") === payload.id) return false;
  await restoreClientBackup(remapClient(payload.state, payload.mappings));
  localStorage.setItem("piora-transfer-applied", payload.id);
  window.location.reload(); return true;
}
export function ApplicationRestoreGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; startup ??= restore(); void startup.then((reloading) => { if (active && !reloading) setReady(true); }).catch((error) => { startup = undefined; if (active) setError(String(error)); }); return () => { active = false; }; }, [retry]);
  if (ready) return children;
  return <div role={error ? "alert" : "status"} style={{ margin: "auto", padding: 24, color: "var(--text)", fontSize: "var(--text-sm)" }}>{error ? <>恢复界面数据失败 / Could not restore interface data: {error}<p><button onClick={() => { setError(""); setRetry(retry + 1); }}>重试 / Retry</button></p></> : "正在准备应用数据… / Preparing application data…"}</div>;
}
