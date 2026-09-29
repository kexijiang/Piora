"use client";

import { useEffect, useState } from "react";
import { TextDiff } from "./TextDiff";

type Preview = { path: string; sourceHash: string; before: string; after: string; changes: Array<{ field: string; before?: boolean; after: boolean }> };

export function PrivilegeConfig({ bundleName, cwd, chinese }: { bundleName?: string; cwd?: string | null; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [path, setPath] = useState(""), [bundle, setBundle] = useState(bundleName ?? ""), [fingerprint, setFingerprint] = useState("");
  const [singleton, setSingleton] = useState(false), [extension, setExtension] = useState(false);
  const [preview, setPreview] = useState<Preview>(), [backupPath, setBackupPath] = useState(""), [appliedHash, setAppliedHash] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { if (bundleName) { setBundle(bundleName); setPreview(undefined); } }, [bundleName]);
  const clearPreview = () => { setPreview(undefined); setNotice(""); };
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/harmony/privileges", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Privilege configuration failed");
    return data.result;
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const fields = () => ({ path: path.trim(), bundleName: bundle.trim(), fingerprint: fingerprint.trim(), singleton, allowAppUsePrivilegeExtension: extension });
  return <details><summary>{copy("开发板系统镜像特权配置", "Development board system-image privileges")}</summary>
    <p>{copy("仅编辑已获准工作区中的 install_list_capability.json；需要匹配 HAP 签名的 SHA-256 指纹。写入本地镜像配置不代表设备已生效，镜像部署、重启和真机验证由开发板流程完成。", "Edits install_list_capability.json only inside an allowed workspace. Supply the HAP certificate SHA-256 fingerprint. A local image edit does not prove device effect; deployment, reboot and device verification remain part of the board workflow.")}</p>
    <label>{copy("镜像配置完整路径", "Full image configuration path")}<input value={path} onChange={event => { setPath(event.target.value); clearPreview(); }} placeholder={cwd ? `${cwd}\\install_list_capability.json` : undefined} /></label>
    <label>{copy("应用包名", "App bundle")}<input value={bundle} onChange={event => { setBundle(event.target.value); clearPreview(); }} /></label>
    <label>{copy("证书 SHA-256 指纹（64 位十六进制）", "Certificate SHA-256 fingerprint (64 hex digits)")}<input value={fingerprint} maxLength={64} onChange={event => { setFingerprint(event.target.value); clearPreview(); }} /></label>
    <label><input type="checkbox" checked={singleton} onChange={event => { setSingleton(event.target.checked); clearPreview(); }} />singleton</label>
    <label><input type="checkbox" checked={extension} onChange={event => { setExtension(event.target.checked); clearPreview(); }} />allowAppUsePrivilegeExtension</label>
    <button disabled={busy || !path || !bundle || !/^[a-fA-F0-9]{64}$/.test(fingerprint)} onClick={() => void run(async () => setPreview(await request({ action: "preview", ...fields() })))}>{copy("预览配置差异", "Preview configuration diff")}</button>
    {preview ? <><p>SHA-256 {preview.sourceHash}</p><ul>{preview.changes.map(change => <li key={change.field}>{change.field}: {String(change.before ?? "unset")} → {String(change.after)}</li>)}</ul>
      <TextDiff original={preview.before} edited={preview.after} chinese={chinese} />
      <button disabled={busy || preview.changes.length === 0} onClick={() => void run(async () => {
        const result = await request({ action: "apply", ...fields(), expectedHash: preview.sourceHash });
        setBackupPath(result.backupPath); setAppliedHash(result.appliedHash); setPreview(undefined);
        setNotice(copy(`已写入工作区配置并核对哈希；备份：${result.backupPath}。设备效果仍须部署镜像后验证。`, `Workspace configuration written and hash-checked; backup: ${result.backupPath}. Device effect still requires image deployment and verification.`));
      })}>{copy("备份并写入工作区配置", "Back up and write workspace config")}</button></> : null}
    {backupPath ? <><label>{copy("本次备份路径", "Backup path")}<input readOnly value={backupPath} /></label>
      <button disabled={busy || !appliedHash} onClick={() => void run(async () => {
        const result = await request({ action: "restore", path, backupPath, expectedHash: appliedHash });
        setBackupPath(result.backupPath); setAppliedHash(result.restoredHash);
        setNotice(copy(`已恢复并核对哈希；恢复前的配置另存于 ${result.backupPath}。`, `Restored and hash-checked; the replaced configuration is saved at ${result.backupPath}.`));
      })}>{copy("从备份恢复", "Restore backup")}</button></> : null}
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </details>;
}
