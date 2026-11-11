"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { VaultEntry, VaultRequest, VaultSnapshot } from "@/desktop/src/credential-vault-types";
import styles from "./CredentialVaultSettings.module.css";

const empty: Partial<VaultEntry> = { name: "", url: "", username: "", password: "", notes: "", group: "" };
export function CredentialVaultSettings() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [state, setState] = useState<VaultSnapshot>();
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState(empty);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useCallback(async (input: VaultRequest) => {
    const bridge = window.piDesktop?.vault;
    if (!bridge) return false;
    setBusy(true); setError(false);
    try { setState(await bridge.request(input)); return true; }
    catch { setError(true); return false; }
    finally { setBusy(false); setPassword(""); }
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.piDesktop?.vault?.request({ action: "status" }).then(value => { if (active) { setState(value); if (!value.unlocked) { setDraft(empty); setPassword(""); } } }).catch(() => {}); };
    refresh(); const timer = setInterval(refresh, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!state) return null;
  const copy = (cn: string, en: string) => zh ? cn : en;
  const field = (key: keyof typeof empty, label: string, type = "text") => <label>{label}<input type={type} value={draft[key] ?? ""} autoComplete="off" onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} /></label>;
  return <section className={styles.card} aria-label={copy("本地凭据库", "Local credential vault")}>
    <h3>{copy("本地凭据库", "Local credential vault")}</h3>
    <p>{copy("凭据使用系统加密保存。主密码至少 12 位，解锁持续 10 分钟。填写仅支持桌面浏览器的 HTTPS 登录表单，并严格匹配站点与路径。", "Credentials are encrypted by the operating system. Use a master password of at least 12 characters; unlock lasts 10 minutes. Filling supports HTTPS login forms in the desktop browser with exact site and path matching.")}</p>
    <p>{copy("填写后的页面仅供你操作。请手动确认登录，完成后关闭受保护页面；不会自动提交、处理验证码、支付或安全设置。", "Filled pages are private to you. Confirm login yourself, then close the protected page. Submission, verification codes, payments and security settings remain manual.")}</p>
    {!state.available ? <p role="status">{copy("系统加密不可用，凭据库已禁用。", "System encryption is unavailable; the vault is disabled.")}</p> : <fieldset disabled={busy}>
      <label>{copy("主密码（导入时填写备份密码）", "Master password (backup password for import)")}<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
      {!state.unlocked ? <button type="button" disabled={password.length < 12} onClick={() => { void request({ action: state.initialized ? "unlock" : "initialize", password }); }}>{state.initialized ? copy("解锁", "Unlock") : copy("创建凭据库", "Create vault")}</button> : <>
        <div className={styles.actions}>
          <button type="button" onClick={() => { setDraft(empty); void request({ action: "lock" }); }}>{copy("锁定", "Lock")}</button>
          <button type="button" disabled={password.length < 12} onClick={() => { void request({ action: "export", password }); }}>{copy("验证并导出加密备份", "Verify and export encrypted backup")}</button>
          <button type="button" disabled={password.length < 12} onClick={() => { void request({ action: "import", password }); }}>{copy("导入加密备份", "Import encrypted backup")}</button>
        </div>
        <label className={styles.toggle}><input type="checkbox" checked={state.autofill} onChange={event => { void request({ action: "configure", enabled: event.target.checked }); }} />{copy("自动填写唯一匹配的登录页（默认关闭）", "Automatically fill a uniquely matched login page (off by default)")}</label>
        <p>{copy("多个匹配账户请通过浏览器登录菜单选择。关闭自动填写后仍可手动填写。备份使用导出时的主密码再次加密，请妥善保管密码。", "Choose between matching accounts in the browser login menu. Manual filling remains available when autofill is off. Backups are separately encrypted with the master password used at export; keep that password safe.")}</p>
        <label>{copy("搜索名称、站点或分组", "Search name, site or group")}<input value={search} onChange={event => setSearch(event.target.value)} /></label>
        <ul>{state.entries.filter(item => `${item.name} ${item.url} ${item.group}`.toLowerCase().includes(search.toLowerCase())).map(item => <li key={item.id}>
          <span><strong>{item.name}</strong> · {item.group}<br />{item.url} · ••••••</span>
          <div className={styles.actions}>
            <button type="button" onClick={() => setDraft({ ...item, password: "" })}>{copy("编辑", "Edit")}</button>
            <button type="button" onClick={() => { void request({ action: "fill", id: item.id }); }}>{copy("填入当前浏览器", "Fill current browser")}</button>
            <button type="button" onClick={() => { if (window.confirm(copy("删除此凭据？", "Delete this credential?"))) void request({ action: "remove", id: item.id }); }}>{copy("删除", "Delete")}</button>
          </div>
        </li>)}</ul>
        <div className={styles.fields}>
          {field("name", copy("名称", "Name"))}{field("group", copy("分组", "Group"))}
          {field("url", copy("完整登录页 URL", "Exact login page URL"), "url")}{field("username", copy("用户名", "Username"), "password")}
          {field("password", draft.id ? copy("密码（留空保留）", "Password (leave empty to keep)") : copy("密码", "Password"), "password")}{field("notes", copy("备注", "Notes"))}
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={() => { void request({ action: "save", entry: draft }).then(ok => { if (ok) setDraft(empty); }); }}>{draft.id ? copy("保存修改", "Save changes") : copy("添加凭据", "Add credential")}</button>
          <button type="button" onClick={() => setDraft(empty)}>{copy("清空编辑", "Clear editor")}</button>
        </div>
        <details><summary>{copy("最近填写记录（不含密码）", "Recent fills (no passwords)")}</summary><ul>{state.audit.map((item, index) => <li key={`${item.at}-${index}`}>{new Date(item.at).toLocaleString()} · {item.name} · {item.origin}</li>)}</ul></details>
      </>}
      <button type="button" onClick={() => { void request({ action: "release" }); }}>{copy("关闭当前会话的受保护页面并恢复智能体", "Close this chat's protected pages and resume agent")}</button>
    </fieldset>}
    {error && <p role="alert">{copy("操作未完成。请检查密码、备份及当前登录页；不符合填写规则的页面请手动登录。", "Operation not completed. Check the password, backup and current login page. Sign in manually on unsupported pages.")}</p>}
  </section>;
}
