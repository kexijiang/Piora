"use client";
import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { snapshotClientBackup } from "@/lib/app-backup-client";
import type { BackupManifest } from "@/lib/app-backup-archive";
import styles from "./SettingsPortabilityCard.module.css";

export function ApplicationBackupCard() {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [status, setStatus] = useState(""); const [error, setError] = useState("");
  const [upload, setUpload] = useState<{ id: string; name: string } | null>(null); const [preview, setPreview] = useState<BackupManifest | null>(null); const [mappings, setMappings] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false); const input = useRef<HTMLInputElement>(null);
  const api = async (body: unknown) => { const response = await fetch("/api/settings/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; };
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (error) { setStatus(""); setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const exportAll = () => run(async () => {
    setStatus(zh ? "正在读取应用数据并加密备份，大型语音包可能需要几分钟…" : "Reading and encrypting application data. Large speech packs may take a few minutes…");
    const result = await api({ action: "export", password, client: await snapshotClientBackup() });
    const anchor = document.createElement("a"); anchor.href = `/api/settings/backup?id=${result.id}`; anchor.download = `piora-${new Date().toISOString().slice(0, 10)}.piora`; anchor.click();
    setStatus(zh ? `备份已生成：${result.manifest.files} 个文件，${(result.manifest.bytes / 1024 ** 2).toFixed(1)} MB。请确认文件下载完成并保管好密码。` : `Backup ready: ${result.manifest.files} files, ${(result.manifest.bytes / 1024 ** 2).toFixed(1)} MB. Verify the download and keep your password.`);
  });
  const previewFile = (file?: File) => run(async () => {
    if (!file && !upload) return; setPreview(null); setMappings({});
    let current = upload;
    if (file) { setStatus(zh ? "正在上传备份…" : "Uploading backup…"); const response = await fetch("/api/settings/backup", { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file }); const data = await response.json(); if (!response.ok) throw new Error(data.error); current = { id: data.id, name: file.name }; setUpload(current); }
    setStatus(zh ? "正在验证密码、备份完整性和文件校验值…" : "Checking the password, archive integrity and file checksums…");
    const result = await api({ action: "preview", id: current!.id, password }); setPreview(result.manifest); setStatus("");
  });
  const restart = async () => { const restarted = await window.piDesktop?.restartForDataImport?.(); if (!restarted) setStatus(zh ? "备份已准备好。请完全退出并重新启动 Piora（网页版请重启服务进程），重启时会完成恢复。" : "Restore is ready. Quit and restart Piora (restart the server process in web mode) to finish restoring." ); };
  const apply = () => run(async () => { if (!upload) return; setStatus(zh ? "正在准备恢复，原数据将保留为恢复副本…" : "Preparing restore and retaining the original data as a recovery copy…"); await api({ action: "prepare", id: upload.id, previousClient: await snapshotClientBackup(), mappings: Object.entries(mappings).filter(([, to]) => to.trim()).map(([from, to]) => ({ from, to: to.trim() })) }); setReady(true); await restart(); });
  const errors: Record<string, [string, string]> = {
    backup_auth: ["密码错误或备份已损坏。请检查后重试，原数据未更改。", "Wrong password or damaged archive. Check and retry; existing data is unchanged."],
    backup_password: ["请使用至少 8 个字符的备份密码。", "Use a backup password with at least 8 characters."],
    backup_busy: ["请等待正在运行的任务结束后再迁移。", "Wait for active tasks to finish before migrating."],
    backup_changed: ["备份期间数据发生变化，请停止编辑后重试。", "Data changed during backup. Stop editing and retry."],
    backup_mapping: ["请选择新电脑上实际存在的项目文件夹。", "Choose existing project folders on this computer."],
    backup_clipboard_unavailable: ["剪贴板快照服务不可用，请在新版桌面端重试备份。", "Clipboard snapshots are unavailable. Retry from the updated desktop app."],
    backup_clipboard_timeout: ["生成剪贴板快照超时，请稍后重试。", "The clipboard snapshot timed out. Please retry."],
    backup_clipboard_overlap: ["剪贴板目录与应用数据或恢复目录重叠，请先将应用数据目录移到桌面数据目录之外再恢复。", "Clipboard and application or recovery directories overlap. Move application data outside the desktop data directory before restoring."],
  };
  return <section className={styles.card}>
    <div className={styles.header}><div><h3>{zh ? "完整备份与迁移" : "Full backup and migration"}</h3><p>{zh ? "迁移模型配置与凭据、全部会话、随身仓、桌面剪贴板历史与屏幕暂存、插件资源、应用设置、草稿、自定义背景和已下载语音包。" : "Move model configuration and credentials, all sessions, Pocket, desktop clipboard history and shelf, plugin resources, settings, drafts, backgrounds and downloaded speech packs."}</p></div></div>
    <p className={styles.securityNote}>{zh ? "备份使用密码加密。项目源码不打包；浏览器登录和系统集成可能需要在新电脑重新授权。" : "Backups are password encrypted. Project source files are excluded; browser sign-in and system integrations may require authorization on the new computer."}</p>
    <label style={{ display: "grid", gap: 6 }}>{zh ? "备份密码（至少 8 个字符）" : "Backup password (at least 8 characters)"}<input type="password" autoComplete="new-password" value={password} disabled={busy || ready} onChange={(event) => setPassword(event.target.value)} style={{ maxWidth: 360, padding: 9, borderRadius: 6, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} /></label>
    <div className={styles.actions}><button type="button" className={styles.primaryButton} disabled={busy || ready || password.length < 8} onClick={() => void exportAll()}>{zh ? "导出全部应用数据" : "Export all application data"}</button><button type="button" className={styles.secondaryButton} disabled={busy || ready || password.length < 8} onClick={() => input.current?.click()}>{zh ? "导入迁移备份" : "Import migration backup"}</button>{upload && !preview && !ready ? <button type="button" disabled={busy || password.length < 8} onClick={() => void previewFile()}>{zh ? "重新校验" : "Retry verification"}</button> : null}</div>
    <input ref={input} hidden type="file" accept=".piora" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void previewFile(file); }} />
    {status ? <p role="status" className={styles.status}>{status}</p> : null}{error ? <p role="alert" className={styles.error}>{errors[error]?.[zh ? 0 : 1] ?? (zh ? `备份操作未完成：${error}` : `Backup operation failed: ${error}`)}</p> : null}
    {preview && !ready ? <div className={styles.preview}><h4>{upload?.name}</h4><p>{new Date(preview.exportedAt).toLocaleString(locale)} · {preview.files} {zh ? "个文件" : "files"} · {(preview.bytes / 1024 ** 2).toFixed(1)} MB</p><p>{zh ? "导入将用备份恢复应用数据，当前数据会保留在独立的恢复副本中。项目路径可以现在重新关联，也可保留原路径稍后处理。" : "Import restores application data from the backup and retains current data in a separate recovery copy. Reassociate project folders now, or keep their original paths for later."}</p>
      {preview.projects.map((project) => <label key={project} style={{ display: "grid", gap: 5, marginBlock: 12, overflowWrap: "anywhere" }}><span>{project}</span><input aria-label={`${zh ? "新项目路径" : "New project path"}: ${project}`} placeholder={zh ? "新电脑的项目文件夹（留空保留原路径）" : "New project folder (blank keeps original path)"} value={mappings[project] ?? ""} onChange={(event) => setMappings({ ...mappings, [project]: event.target.value })} /></label>)}
      {preview.warnings.length > 2 ? <details><summary>{zh ? "未打包的链接资源" : "Excluded linked resources"}</summary>{preview.warnings.slice(2).map((warning, index) => <p key={index} style={{ overflowWrap: "anywhere" }}>{warning}</p>)}</details> : null}
      <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void apply()}>{zh ? "导入并重启" : "Import and restart"}</button></div> : null}
    {ready ? <button type="button" disabled={busy} onClick={() => void run(restart)}>{zh ? "重新启动 Piora" : "Restart Piora"}</button> : null}
  </section>;
}
