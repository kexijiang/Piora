"use client";
import { useEffect, useRef, useState } from "react";
import type { HarmonyApplication } from "@/lib/harmony/observation/applications";
import type { HarmonyReceipt } from "@/lib/harmony/contracts/receipts";
type AppAction = "launch_app" | "stop_app" | "clear_app_data" | "uninstall_app" | "install_app" | "enable_app" | "disable_app";
export function ApplicationPicker({ serial, canControl, ensureControl, chinese, cwd }: { serial: string; canControl: boolean; ensureControl: () => Promise<string>; chinese: boolean; cwd?: string | null }) {
  const [query, setQuery] = useState(""), [applications, setApplications] = useState<HarmonyApplication[]>([]);
  const [selected, setSelected] = useState<HarmonyApplication>(), [ability, setAbility] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [recent, setRecent] = useState<string[]>([]);
  const [hapPath, setHapPath] = useState(""), [replace, setReplace] = useState(true);
  const controller = useRef<AbortController | null>(null), copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(`harmony-recent-apps:${serial}`) ?? "[]"); if (Array.isArray(value)) setRecent(value.filter(item => typeof item === "string").slice(0, 5)); } catch { /* Optional history. */ } return () => controller.current?.abort(); }, [serial]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => { if (busy) return; const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setMessage(""); try { await work(current.signal); } catch (error) { if (!current.signal.aborted) setError(String(error)); } finally { setBusy(false); } };
  const read = async (params: string, signal: AbortSignal) => { const response = await fetch(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&${params}`, { signal, cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error); return data.applications as HarmonyApplication[]; };
  const select = (bundle: string) => void run(async signal => { const app = (await read(`bundleName=${encodeURIComponent(bundle)}`, signal))[0]; if (!app) throw new Error(copy("未找到此应用，请重新搜索", "App not found; search again")); setSelected(app); setAbility(app.abilities?.length === 1 ? app.abilities[0] : ""); });
  const dispatch = async (action: AppAction, fields: Record<string, unknown>, signal: AbortSignal): Promise<HarmonyReceipt> => {
    const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ action, serial, leaseToken: await ensureControl(), ...fields }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
    return data.result.receipt as HarmonyReceipt;
  };
  const report = (receipt: HarmonyReceipt) => setMessage(receipt.verification === "passed" ? copy("设备已验证操作结果。", "The device verified the result.") : copy("设备已接收命令；效果尚未独立验证，请刷新应用列表核对。", "Command sent; effect is not independently verified. Refresh the app list to check."));
  const actOnSelected = (action: Exclude<AppAction, "install_app">) => {
    if (!selected) return;
    if (action === "clear_app_data" && !window.confirm(copy(`清除 ${selected.bundleName} 的全部应用数据？`, `Clear all app data for ${selected.bundleName}?`))) return;
    if (action === "uninstall_app" && !window.confirm(copy(`从设备卸载 ${selected.bundleName}？`, `Uninstall ${selected.bundleName} from the device?`))) return;
    if (action === "disable_app" && !window.confirm(copy(`禁用当前用户的 ${selected.bundleName}？`, `Disable ${selected.bundleName} for the active user?`))) return;
    void run(async signal => {
      report(await dispatch(action, { bundleName: selected.bundleName, ...(action === "launch_app" ? { abilityName: ability } : {}) }, signal));
      if (action === "launch_app") { const next = [selected.bundleName, ...recent.filter(value => value !== selected.bundleName)].slice(0, 5); setRecent(next); try { localStorage.setItem(`harmony-recent-apps:${serial}`, JSON.stringify(next)); } catch { /* Optional history. */ } }
      if (action === "uninstall_app") { setSelected(undefined); setApplications(await read(`query=${encodeURIComponent(query)}`, signal)); }
    });
  };
  return <section aria-label={copy("应用管理", "Application management")}>
    <h3>{copy("手机应用", "Phone apps")}</h3>
    <label>{copy("应用名称或包标识", "App name or bundle")}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button disabled={busy} onClick={() => void run(async signal => setApplications(await read(`query=${encodeURIComponent(query)}`, signal)))}>{copy("搜索或刷新应用", "Search or refresh apps")}</button>
    {recent.length ? <p>{copy("最近测试", "Recently tested")}: {recent.map(bundle => <button key={bundle} disabled={busy} onClick={() => select(bundle)}>{bundle}</button>)}</p> : null}
    <ul aria-label={copy("搜索结果", "Search results")}>{applications.map(app => <li key={app.bundleName}><button disabled={busy} onClick={() => select(app.bundleName)}>{app.label ?? app.bundleName}</button><small> {app.bundleName}</small></li>)}</ul>
    {selected ? <fieldset><legend>{selected.bundleName}</legend>
      <p>{copy("版本", "Version")}: {selected.versionName ?? copy("设备未提供", "Not reported")}{selected.versionCode === undefined ? "" : ` (${selected.versionCode})`}</p>
      {selected.installTime ? <p>{copy("安装时间", "Installed")}: {new Date(selected.installTime).toLocaleString()}</p> : null}
      {selected.requestedPermissions?.length ? <details><summary>{copy("申请的权限", "Requested permissions")} ({selected.requestedPermissions.length})</summary><ul>{selected.requestedPermissions.map(permission => <li key={permission}><code>{permission}</code></li>)}</ul></details> : null}
      <label>{copy("启动入口", "Launch ability")}<select value={ability} onChange={event => setAbility(event.target.value)}><option value="">{copy("选择已发现入口", "Choose a discovered ability")}</option>{selected.abilities?.map(name => <option key={name}>{name}</option>)}</select></label>
      <button disabled={busy || !canControl || !ability} onClick={() => actOnSelected("launch_app")}>{copy("启动", "Launch")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("stop_app")}>{copy("停止", "Stop")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("clear_app_data")}>{copy("清除数据", "Clear data")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("uninstall_app")}>{copy("卸载", "Uninstall")}</button></fieldset> : null}
    {selected ? <details><summary>{copy("高级：应用使能状态", "Advanced: app enabled state")}</summary>
      <p>{copy("仅 root 设备构建支持 bm enable/disable。操作只针对当前活跃用户；user 构建会报告设备不支持。", "bm enable/disable requires a root device build and targets the active user only. User builds report that the capability is unavailable.")}</p>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("enable_app")}>{copy("使能应用", "Enable app")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("disable_app")}>{copy("禁用应用", "Disable app")}</button>
    </details> : null}
    <fieldset><legend>{copy("安装 HAP", "Install HAP")}</legend>
      <p>{copy("输入已获准工作区内的本地 HAP 完整路径。安装前会冻结并校验文件。", "Enter the full path of a local HAP in an allowed workspace. The file is frozen and checked before installation.")}</p>
      <label>{copy("HAP 完整路径", "Full HAP path")}<input value={hapPath} onChange={event => setHapPath(event.target.value)} placeholder={cwd ? `${cwd}\\app.hap` : undefined} /></label>
      <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />{copy("替换已安装版本", "Replace existing version")}</label>
      <button disabled={busy || !canControl || !hapPath.trim()} onClick={() => void run(async signal => report(await dispatch("install_app", { hapPath: hapPath.trim(), replace }, signal)))}>{copy("安装", "Install")}</button>
    </fieldset>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消操作", "Cancel operation")}</button> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
