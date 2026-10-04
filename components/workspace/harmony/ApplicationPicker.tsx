"use client";
import { useEffect, useRef, useState } from "react";
import type { HarmonyApplication } from "@/lib/harmony/observation/applications";
import type { HarmonyReceipt } from "@/lib/harmony/contracts/receipts";
import type { HarmonyHapPreview } from "@/lib/harmony/hap-preview";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { PrivilegeConfig } from "./PrivilegeConfig";
import styles from "../HarmonyPanel.module.css";
type AppAction = "launch_app" | "stop_app" | "clear_app_data" | "clear_app_cache" | "uninstall_app" | "install_app" | "enable_app" | "disable_app";
export function ApplicationPicker({ serial, active = true, canControl, ensureControl, chinese, cwd, onOpenSandbox }: { serial: string; active?: boolean; canControl: boolean; ensureControl: () => Promise<string>; chinese: boolean; cwd?: string | null; onOpenSandbox?: (bundleName: string) => void }) {
  const [query, setQuery] = useState(""), [applications, setApplications] = useState<HarmonyApplication[]>([]);
  const [selected, setSelected] = useState<HarmonyApplication>(), [ability, setAbility] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [recent, setRecent] = useState<string[]>([]);
  const [hapPath, setHapPath] = useState(""), [replace, setReplace] = useState(true);
  const [hapPreview, setHapPreview] = useState<{ path: string; package: HarmonyHapPreview; installed?: HarmonyApplication; installedState: "found" | "absent" | "unavailable" }>();
  const [category, setCategory] = useState("all"), [page, setPage] = useState(0), [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false);
  const [facts, setFacts] = useState<Record<string, HarmonyApplication>>({});
  const factsRef = useRef<Record<string, HarmonyApplication>>({});
  const [scan, setScan] = useState({ running: false, done: 0, total: 0 }), [scanKey, setScanKey] = useState(0);
  const scanController = useRef<AbortController | null>(null), runningRef = useRef(false);
  const [processSample, setProcessSample] = useState<{ bundleName: string; pids: number[]; sampledAt: string }>(), [processKey, setProcessKey] = useState(0);
  const controller = useRef<AbortController | null>(null), copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(`harmony-recent-apps:${serial}`) ?? "[]"); if (Array.isArray(value)) setRecent(value.filter(item => typeof item === "string").slice(0, 5)); } catch { /* Optional history. */ } return () => controller.current?.abort(); }, [serial]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => { if (runningRef.current) return; const current = new AbortController(); controller.current = current; runningRef.current = true; setBusy(true); setError(""); setMessage(""); try { await work(current.signal); } catch (error) { if (!current.signal.aborted) setError(error instanceof HarmonyRequestError ? error.messageFor(chinese) : error instanceof Error ? error.message : String(error)); } finally { runningRef.current = false; setBusy(false); } };
  const read = async (params: string, signal: AbortSignal) => { const response = await fetch(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&${params}`, { signal, cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new HarmonyRequestError(data.error, response.status); if (!Array.isArray(data.applications) || data.applications.length > 5000) throw new Error("Invalid application list"); return data.applications as HarmonyApplication[]; };
  const remember = (app: HarmonyApplication) => { factsRef.current = { ...factsRef.current, [app.bundleName]: app }; setFacts(factsRef.current); };
  const select = (bundle: string) => void run(async signal => { const detail = (await read(`bundleName=${encodeURIComponent(bundle)}`, signal))[0]; if (signal.aborted) return; if (!detail || detail.bundleName !== bundle) throw new Error(copy("未找到此应用，请重新搜索", "App not found; search again")); const app = { ...applications.find(item => item.bundleName === bundle), ...detail }; remember(app); setSelected(app); setAbility(app.abilities?.length === 1 ? app.abilities[0] : ""); });
  useEffect(() => { setApplications([]); setSelected(undefined); setFacts({}); factsRef.current = {}; setLoaded(false); setPage(0); setProcessSample(undefined); setHapPreview(undefined); }, [serial]);
  useEffect(() => {
    if (!active || !serial) return;
    const current = new AbortController(); setLoading(true); setError("");
    void read("", current.signal).then(apps => { if (current.signal.aborted) return; setApplications(apps); setLoaded(true); setSelected(undefined); factsRef.current = {}; setFacts({}); })
      .catch(failure => { if (!current.signal.aborted) setError(failure instanceof HarmonyRequestError ? failure.messageFor(chinese) : String(failure)); })
      .finally(() => { if (!current.signal.aborted) setLoading(false); });
    return () => current.abort();
    // Explicit activation/refresh only; local search and selection do not reread the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, serial, refreshKey]);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => { setPage(0); }, [query, category]);
  useEffect(() => {
    if (!active || !loaded || (category !== "system" && category !== "third-party")) { setScan(value => ({ ...value, running: false })); return; }
    const targets = applications.filter(app => (factsRef.current[app.bundleName] ?? app).isSystemApp === undefined);
    const current = new AbortController(); scanController.current = current;
    let cursor = 0, done = 0; setScan({ running: targets.length > 0, done, total: targets.length });
    const timer = window.setTimeout(() => current.abort(), 120_000);
    const worker = async () => { while (!current.signal.aborted && cursor < targets.length) {
      const app = targets[cursor++];
      try { const detail = (await read(`bundleName=${encodeURIComponent(app.bundleName)}`, current.signal))[0]; if (current.signal.aborted) return; if (detail?.bundleName === app.bundleName) remember({ ...app, ...detail }); }
      catch { if (current.signal.aborted) return; }
      done++; setScan({ running: true, done, total: targets.length });
    } };
    void Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker)).finally(() => { window.clearTimeout(timer); if (scanController.current === current) setScan({ running: false, done, total: targets.length }); });
    return () => { current.abort(); window.clearTimeout(timer); scanController.current = null; };
    // Each result updates facts separately, so classification progress does not restart scanning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loaded, applications, category, serial, scanKey]);
  useEffect(() => {
    if (!active || !selected) return;
    const current = new AbortController(); setProcessSample(undefined);
    void fetch(`/api/harmony/logs?action=processes&serial=${encodeURIComponent(serial)}`, { cache: "no-store", signal: current.signal })
      .then(async response => { const data = await response.json(); if (!response.ok || !Array.isArray(data.processes)) throw new Error("Process list unavailable"); return data.processes as Array<{ pid: number; name: string }>; })
      .then(processes => { if (current.signal.aborted) return; const names = [selected.bundleName, selected.process].filter((name): name is string => Boolean(name)); setProcessSample({ bundleName: selected.bundleName, sampledAt: new Date().toISOString(), pids: processes.filter(process => names.some(name => process.name === name || process.name.startsWith(`${name}:`))).map(process => process.pid) }); }).catch(() => undefined);
    return () => current.abort();
  }, [active, serial, selected, processKey]);
  const dispatch = async (action: AppAction, fields: Record<string, unknown>, signal: AbortSignal): Promise<HarmonyReceipt> => {
    const leaseToken = await ensureControl(); if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ action, serial, leaseToken, ...fields }) });
    const data = await response.json(); if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
    return data.result.receipt as HarmonyReceipt;
  };
  const report = (receipt: HarmonyReceipt) => setMessage(receipt.verification === "passed" ? copy("设备已验证操作结果。", "The device verified the result.") : copy("设备已接收命令；效果尚未独立验证，请刷新应用列表核对。", "Command sent; effect is not independently verified. Refresh the app list to check."));
  const actOnSelected = (action: Exclude<AppAction, "install_app">) => {
    if (!selected) return;
    void run(async signal => {
      report(await dispatch(action, { bundleName: selected.bundleName, ...(action === "launch_app" ? { abilityName: ability } : {}) }, signal));
      if (action === "launch_app") { const next = [selected.bundleName, ...recent.filter(value => value !== selected.bundleName)].slice(0, 5); setRecent(next); try { localStorage.setItem(`harmony-recent-apps:${serial}`, JSON.stringify(next)); } catch { /* Optional history. */ } }
      if (signal.aborted) return;
      if (action === "uninstall_app") { const apps = await read("", signal); if (signal.aborted) return; setApplications(apps); if (!apps.some(app => app.bundleName === selected.bundleName)) setSelected(undefined); }
      else { try { const app = (await read(`bundleName=${encodeURIComponent(selected.bundleName)}`, signal))[0]; if (!signal.aborted && app) { const next = { ...selected, ...app }; remember(next); setSelected(next); } } catch { if (!signal.aborted) setError(copy("命令已发出，但状态回读失败；请刷新并核对设备。", "Command sent, but state reread failed; refresh and check the device.")); } }
      setProcessKey(key => key + 1);
    });
  };
  const openSandbox = () => { if (!selected || !onOpenSandbox) return; void run(async signal => {
    const params = new URLSearchParams({ serial, kind: "sandbox", bundleName: selected.bundleName, path: "data/storage/el2/base" });
    const response = await fetch(`/api/harmony/files?${params}`, { cache: "no-store", signal }); const data = await response.json();
    if (!response.ok) throw new HarmonyRequestError(data.error, response.status); if (!signal.aborted) onOpenSandbox(selected.bundleName);
  }); };
  const previewHap = () => void run(async signal => {
    setHapPreview(undefined);
    const path = hapPath.trim();
    const response = await fetch("/api/harmony/packages", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ action: "preview", hapPath: path }) });
    const data = await response.json(); if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
    const preview = data.preview as HarmonyHapPreview;
    if (!preview || !/^[a-f0-9]{64}$/.test(preview.sha256) || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(preview.bundleName) || preview.signature !== "unverified") throw new Error(copy("安装包预览返回无效，请重新读取。", "Invalid package preview; read it again."));
    let installed: HarmonyApplication | undefined, installedState: "found" | "absent" | "unavailable" = "unavailable";
    try { installed = (await read(`bundleName=${encodeURIComponent(preview.bundleName)}`, signal))[0]; installedState = installed?.bundleName === preview.bundleName ? "found" : "absent"; }
    catch { /* A package preview does not imply that the device's current install was readable. */ }
    if (!signal.aborted) setHapPreview({ path, package: preview, installed: installedState === "found" ? installed : undefined, installedState });
  });
  const enriched = applications.map(app => ({ ...app, ...facts[app.bundleName], label: app.label ?? facts[app.bundleName]?.label }));
  const unknownCount = enriched.filter(app => app.isSystemApp === undefined).length;
  const filtered = enriched.filter(app => `${app.bundleName}\n${app.label ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (category === "all" || category === "unknown" && app.isSystemApp === undefined || category === "system" && app.isSystemApp === true || category === "third-party" && app.isSystemApp === false));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 100) - 1));
  const appCategory = (app: HarmonyApplication) => app.isSystemApp === undefined ? copy("分类未确认", "Type unknown") : app.isSystemApp ? copy("系统应用", "System app") : copy("第三方应用", "Third-party app");
  return <section className={styles.applicationWorkbench} aria-label={copy("应用管理", "Application management")}>
    <h3>{copy("手机应用", "Phone apps")}</h3>
    {busy || message || error ? <div className={styles.applicationFeedback} aria-label={copy("应用操作反馈", "Application feedback")}>
      {busy ? <button type="button" onClick={() => controller.current?.abort()}>{copy("取消操作", "Cancel operation")}</button> : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
    <div className={styles.applicationToolbar}><input value={query} onChange={event => setQuery(event.target.value)} aria-label={copy("应用名称或包名", "App name or bundle")} placeholder={copy("搜索应用名称或包名", "Search app name or bundle")} />
      <select value={category} onChange={event => setCategory(event.target.value)} aria-label={copy("应用分类", "Application type")}><option value="all">{copy("全部应用", "All apps")}</option><option value="system">{copy("系统应用", "System apps")}</option><option value="third-party">{copy("第三方应用", "Third-party apps")}</option><option value="unknown">{copy("分类未确认", "Type unknown")}</option></select>
      <button type="button" disabled={busy || loading} onClick={() => setRefreshKey(key => key + 1)}>{copy("搜索或刷新应用", "Search or refresh apps")}</button></div>
    <p className={styles.inlineHint} role="status">{loading ? copy("正在读取设备应用…", "Loading device apps…") : copy(`${filtered.length} / ${applications.length} 个应用`, `${filtered.length} / ${applications.length} apps`)}{unknownCount ? copy(` · ${unknownCount} 个分类未确认`, ` · ${unknownCount} types unknown`) : ""}</p>
    {scan.running ? <div className={styles.applicationScan} role="status"><span>{copy(`正在读取分类 ${scan.done}/${scan.total}；不启动应用`, `Reading types ${scan.done}/${scan.total}; apps are not started`)}</span><button type="button" onClick={() => scanController.current?.abort()}>{copy("停止读取分类", "Stop type scan")}</button></div> : (category === "system" || category === "third-party") && unknownCount > 0 ? <div className={styles.applicationScan}><small>{copy("未确认的应用不归入任一分类。", "Unknown apps are not placed in either type.")}</small><button type="button" onClick={() => setScanKey(key => key + 1)}>{copy("继续读取分类", "Resume type scan")}</button></div> : null}
    {recent.length ? <p>{copy("最近测试", "Recently tested")}: {recent.map(bundle => <button key={bundle} disabled={busy} onClick={() => select(bundle)}>{bundle}</button>)}</p> : null}
    <div className={styles.applicationGrid}><div className={styles.applicationList}>
    <ul aria-label={copy("应用列表", "Application list")}>{filtered.slice(currentPage * 100, (currentPage + 1) * 100).map(app => <li key={app.bundleName}><button type="button" disabled={busy} aria-pressed={selected?.bundleName === app.bundleName} onClick={() => select(app.bundleName)}><strong>{app.label ?? app.bundleName}</strong><code>{app.bundleName}</code><small>{appCategory(app)}</small></button></li>)}</ul>
    {loaded && !filtered.length ? <p className={styles.mediaEmpty}>{applications.length ? copy("没有已确认匹配的应用，未确认分类不代表无应用。", "No confirmed matching apps; unknown types do not mean absent apps.") : copy("设备返回空应用列表", "Device returned an empty list")}</p> : null}
    {filtered.length > 100 ? <div className={styles.applicationPagination}><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{copy("上一页", "Previous")}</button><span>{currentPage + 1}/{Math.ceil(filtered.length / 100)}</span><button type="button" disabled={(currentPage + 1) * 100 >= filtered.length} onClick={() => setPage(currentPage + 1)}>{copy("下一页", "Next")}</button></div> : null}
    </div><div className={styles.applicationInspector}>
    {selected ? <fieldset><legend>{selected.label || selected.bundleName}</legend><code>{selected.bundleName}</code>
      <p>{copy("分类", "Type")}: {appCategory(selected)}</p>
      <p>{copy("版本", "Version")}: {selected.versionName ?? copy("设备未提供", "Not reported")}{selected.versionCode === undefined ? "" : ` (${selected.versionCode})`}</p>
      {selected.installTime ? <p>{copy("安装时间", "Installed")}: {new Date(selected.installTime).toLocaleString()}</p> : null}
      <p>{copy("安装来源", "Install source")}: {selected.installSource ?? copy("设备未提供", "Not reported")}</p>
      <p>{copy("使能状态", "Enabled")}: {selected.enabled === undefined ? copy("未确认", "Unknown") : selected.enabled ? copy("已启用", "Enabled") : copy("已禁用", "Disabled")}</p>
      <p>{copy("进程观察", "Observed processes")}: {processSample?.bundleName !== selected.bundleName ? copy("未确认", "Unknown") : processSample.pids.length ? `PID ${processSample.pids.join(", ")}` : copy("未观察到匹配进程", "No matching process observed")}{processSample?.bundleName === selected.bundleName ? ` · ${new Date(processSample.sampledAt).toLocaleTimeString()}` : ""}</p>
      <small>{copy("进程列表只是此刻的观察，不作为应用已停止的证明。", "Process visibility is a point-in-time observation, not proof that an app stopped.")}</small>
      <button type="button" disabled={busy} onClick={() => setProcessKey(key => key + 1)}>{copy("刷新进程观察", "Refresh processes")}</button>
      {selected.requestedPermissions?.length ? <details><summary>{copy("申请的权限", "Requested permissions")} ({selected.requestedPermissions.length})</summary><ul>{selected.requestedPermissions.map(permission => <li key={permission}><code>{permission}</code></li>)}</ul></details> : null}
      <label>{copy("启动入口", "Launch ability")}<select value={ability} onChange={event => setAbility(event.target.value)}><option value="">{copy("选择已发现入口", "Choose a discovered ability")}</option>{selected.abilities?.map(name => <option key={name}>{name}</option>)}</select></label>
      <button disabled={busy || !canControl || !ability || selected.enabled === false} onClick={() => actOnSelected("launch_app")}>{copy("启动", "Launch")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("stop_app")}>{copy("停止", "Stop")}</button>
      {onOpenSandbox ? <button type="button" disabled={busy || selected.provisionType === "release"} onClick={openSandbox}>{copy("打开应用沙箱", "Open app sandbox")}</button> : null}
      <small>{selected.provisionType === "release" ? copy("发行签名不能使用此调试沙箱入口。", "Release signing cannot use this debug sandbox entry.") : copy("沙箱要求可调试签名且应用已启动，此入口只检查目录，不自动启动。", "Sandbox requires a running debug-signed app; this entry only checks the directory.")}</small>
      <button disabled={busy || !canControl || selected.dataClearable === false} onClick={() => actOnSelected("clear_app_data")}>{copy("清除数据", "Clear data")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("clear_app_cache")}>{copy("清除缓存", "Clear cache")}</button>
      <button disabled={busy || !canControl || selected.removable === false} onClick={() => actOnSelected("uninstall_app")}>{copy("卸载", "Uninstall")}</button>
      {selected.dataClearable === false ? <small>{copy("设备标记此应用数据不可清除。", "Device marks this app's data as unclearable.")}</small> : null}
      {selected.removable === false ? <small>{copy("设备标记此应用不可卸载。", "Device marks this app as non-removable.")}</small> : null}
      </fieldset> : <p className={styles.mediaEmpty}>{copy("选择应用查看详情与可用操作", "Select an app to view details and actions")}</p>}
    {selected ? <details><summary>{copy("高级：应用使能状态", "Advanced: app enabled state")}</summary>
      <p>{copy("仅 root 设备构建支持 bm enable/disable。操作只针对当前活跃用户；user 构建会报告设备不支持。", "bm enable/disable requires a root device build and targets the active user only. User builds report that the capability is unavailable.")}</p>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("enable_app")}>{copy("使能应用", "Enable app")}</button>
      <button disabled={busy || !canControl} onClick={() => actOnSelected("disable_app")}>{copy("禁用应用", "Disable app")}</button>
    </details> : null}</div></div>
    <fieldset><legend>{copy("安装 HAP", "Install HAP")}</legend>
      <p>{copy("选择工作区内的 HAP，先读取包名与版本，再选择目标设备并点击安装。预览只读取本机文件，不安装或取得控制。", "Select a workspace HAP, preview its identity and version, then choose the target device and click Install. Preview only reads local files and does not acquire control.")}</p>
      <label>{copy("HAP 完整路径", "Full HAP path")}<input disabled={busy} value={hapPath} onChange={event => { setHapPath(event.target.value); setHapPreview(undefined); }} placeholder={cwd ? `${cwd}\\app.hap` : undefined} /></label>
      <button type="button" disabled={busy || !hapPath.trim()} onClick={previewHap}>{copy("预览安装包", "Preview package")}</button>
      {hapPreview ? <div className={styles.applicationInspector} aria-label={copy("安装包预览", "Package preview")}>
        <p>{copy("包名", "Bundle")}: <code>{hapPreview.package.bundleName}</code></p>
        <p>{copy("安装版本", "Package version")}: {hapPreview.package.versionName ?? copy("未提供", "Not reported")}{hapPreview.package.versionCode === undefined ? "" : ` (${hapPreview.package.versionCode})`}</p>
        <p>{copy("设备现有版本", "Installed version")}: {hapPreview.installedState === "unavailable" ? copy("无法确认，请在设备上核对", "Unavailable; check on the device") : hapPreview.installedState === "absent" ? copy("当前列表未发现", "Not found in the current device response") : `${hapPreview.installed?.versionName ?? copy("未提供", "Not reported")}${hapPreview.installed?.versionCode === undefined ? "" : ` (${hapPreview.installed.versionCode})`}`}</p>
        <p>{copy("模块", "Module")}: {hapPreview.package.moduleName ?? copy("未提供", "Not reported")} {hapPreview.package.moduleType ?? ""}</p>
        <p>{copy("适用设备", "Device types")}: {hapPreview.package.deviceTypes.join(", ") || copy("未提供", "Not reported")}</p>
        <p>{copy("文件大小", "File size")}: {hapPreview.package.size.toLocaleString()} B</p>
        <p>SHA-256: <code>{hapPreview.package.sha256}</code></p>
        <p>{copy("目标设备", "Target device")}: <code>{serial}</code></p>
        <p>{copy("签名尚未验证，最终由设备安装时校验。", "Signing is unverified; the device validates it during installation.")}</p>
        {hapPreview.package.permissions.length ? <details><summary>{copy("安装包声明的权限", "Declared package permissions")} ({hapPreview.package.permissions.length})</summary><ul>{hapPreview.package.permissions.map(permission => <li key={permission}><code>{permission}</code></li>)}</ul></details> : null}
      </div> : null}
      <label><input type="checkbox" disabled={busy} checked={replace} onChange={event => setReplace(event.target.checked)} />{copy("替换已安装版本", "Replace existing version")}</label>
      <button type="button" disabled={busy || !canControl || !hapPreview || hapPreview.path !== hapPath.trim()} onClick={() => void run(async signal => {
        if (!hapPreview) return;
        try { report(await dispatch("install_app", { hapPath: hapPreview.path, expectedHash: hapPreview.package.sha256, replace }, signal)); }
        catch (failure) { if (failure instanceof HarmonyRequestError && failure.code === "STALE_SNAPSHOT") setHapPreview(undefined); throw failure; }
        if (signal.aborted) return;
        try {
          const installed = (await read(`bundleName=${encodeURIComponent(hapPreview.package.bundleName)}`, signal))[0];
          if (signal.aborted) return;
          const expected = hapPreview.package;
          const versionKnown = expected.versionCode !== undefined || expected.versionName !== undefined;
          const matches = installed?.bundleName === expected.bundleName && versionKnown
            && (expected.versionCode === undefined || installed.versionCode === expected.versionCode)
            && (expected.versionName === undefined || installed.versionName === expected.versionName);
          setMessage(matches ? copy(`已回读设备应用，版本与安装包一致：${expected.bundleName}。`, `Device reread confirms the package version: ${expected.bundleName}.`)
            : copy("安装命令已返回，但目标应用版本尚未核对一致；请刷新并检查设备。", "The install command returned, but the target version is not confirmed; refresh and check the device."));
        } catch { if (!signal.aborted) setMessage(copy("安装命令已返回，设备版本回读失败；请重新连接并核对，勿重复安装。", "The install command returned, but version reread failed; reconnect and verify before repeating installation.")); }
        if (!signal.aborted) { setHapPreview(undefined); setRefreshKey(key => key + 1); }
      })}>{copy("安装", "Install")}</button>
    </fieldset>
    <PrivilegeConfig bundleName={selected?.bundleName} cwd={cwd} chinese={chinese} />
  </section>;
}
