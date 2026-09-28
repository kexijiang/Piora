"use client";
import { useEffect, useRef, useState } from "react";
import type { HarmonyApplication } from "@/lib/harmony/observation/applications";
export function ApplicationPicker({ serial, canControl, ensureControl, chinese }: { serial: string; canControl: boolean; ensureControl: () => Promise<string>; chinese: boolean }) {
  const [query, setQuery] = useState(""), [applications, setApplications] = useState<HarmonyApplication[]>([]);
  const [selected, setSelected] = useState<HarmonyApplication>(), [ability, setAbility] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [recent, setRecent] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null), copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(`harmony-recent-apps:${serial}`) ?? "[]"); if (Array.isArray(value)) setRecent(value.filter(item => typeof item === "string").slice(0, 5)); } catch { /* Optional history. */ } return () => controller.current?.abort(); }, [serial]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => { if (busy) return; const current = new AbortController(); controller.current = current; setBusy(true); setError(""); try { await work(current.signal); } catch (error) { if (!current.signal.aborted) setError(String(error)); } finally { setBusy(false); } };
  const read = async (params: string, signal: AbortSignal) => { const response = await fetch(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&${params}`, { signal, cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error); return data.applications as HarmonyApplication[]; };
  const select = (bundle: string) => void run(async signal => { const app = (await read(`bundleName=${encodeURIComponent(bundle)}`, signal))[0]; if (!app) throw new Error(copy("未找到此应用，请重新搜索", "App not found; search again")); setSelected(app); setAbility(app.abilities?.length === 1 ? app.abilities[0] : ""); });
  return <section aria-label={copy("应用搜索", "Application search")}>
    <h3>{copy("手机应用", "Phone apps")}</h3>
    <label>{copy("应用名称或包标识", "App name or bundle")}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button disabled={busy} onClick={() => void run(async signal => setApplications(await read(`query=${encodeURIComponent(query)}`, signal)))}>{copy("搜索手机应用", "Search phone apps")}</button>
    {recent.length ? <p>{copy("最近测试", "Recently tested")}: {recent.map(bundle => <button key={bundle} disabled={busy} onClick={() => select(bundle)}>{bundle}</button>)}</p> : null}
    <ul aria-label={copy("搜索结果", "Search results")}>{applications.map(app => <li key={app.bundleName}><button disabled={busy} onClick={() => select(app.bundleName)}>{app.label ?? app.bundleName}</button><small> {app.bundleName}</small></li>)}</ul>
    {selected ? <><p>{selected.bundleName}</p><label>{copy("启动入口", "Launch ability")}<select value={ability} onChange={event => setAbility(event.target.value)}><option value="">{copy("选择已发现入口", "Choose a discovered ability")}</option>{selected.abilities?.map(name => <option key={name}>{name}</option>)}</select></label>
      <button disabled={busy || !canControl || !ability} onClick={() => void run(async signal => {
        const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ action: "launch_app", serial, leaseToken: await ensureControl(), bundleName: selected.bundleName, abilityName: ability }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
        const next = [selected.bundleName, ...recent.filter(value => value !== selected.bundleName)].slice(0, 5); setRecent(next); try { localStorage.setItem(`harmony-recent-apps:${serial}`, JSON.stringify(next)); } catch { /* Optional history. */ }
      })}>{copy("启动应用", "Launch app")}</button></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
