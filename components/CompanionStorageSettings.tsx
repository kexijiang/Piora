"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./CompanionStorageSettings.module.css";

interface StorageInfo {
  directory: string;
  defaultDirectory: string;
  dataFile: string;
  configFile: string;
  customized: boolean;
}

interface StoragePayload {
  storage?: StorageInfo;
  error?: string;
}

export function CompanionStorageSettings({ compact = false, scope }: { compact?: boolean; scope?: "library" | "json" }) {
  const { t } = useI18n();
  const headingId = useId();
  const endpoint = `/api/companion/storage${scope ? `?scope=${scope}` : ""}`;
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [directory, setDirectory] = useState("");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json() as StoragePayload;
      if (!response.ok || !payload.storage) throw new Error(payload.error || `HTTP ${response.status}`);
      setStorage(payload.storage);
      setDirectory(payload.storage.directory);
      setError("");
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  const save = async (nextDirectory: string) => {
    setStatus("saving");
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: nextDirectory.trim() }),
      });
      const payload = await response.json() as StoragePayload;
      if (!response.ok || !payload.storage) throw new Error(payload.error || `HTTP ${response.status}`);
      setStorage(payload.storage);
      setDirectory(payload.storage.directory);
      setEditing(false);
      setStatus("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  };

  return (
    <section className={`${styles.section}${compact ? ` ${styles.compact}` : ""}`} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <div>
          <h3 id={headingId}>{scope === "library" ? "中转站存储位置" : scope === "json" ? "JSON 草稿存储位置" : "随身舱其他数据"}</h3>
          <p>{scope === "library" ? "图片单独存为文件，文字保存在 transfer.json。" : scope === "json" ? "所有标签和临时草稿自动保存到本地文件。" : "待办、专注、记忆与陪伴设置。"}</p>
        </div>
      </div>

      <div className={styles.location}>
        <AliIcon name="folder-open" size={15} />
        <code title={storage?.directory}>{storage?.directory || (status === "error" ? "位置读取失败" : "正在读取…")}</code>
        <button type="button" aria-expanded={editing} disabled={status === "saving" || !storage} onClick={() => {
          setEditing((current) => !current);
          setDirectory(storage?.directory ?? "");
          setError("");
          setStatus("idle");
        }}>{editing ? "取消" : "更改"}</button>
      </div>

      {editing ? <div className={styles.editor}>
        <label>
          <span>{t("companion.storage.directory")}</span>
          <span className={styles.inputRow}>
            <input value={directory} onChange={(event) => { setDirectory(event.currentTarget.value); setStatus("idle"); }} />
          </span>
        </label>
        <p>{scope ? "输入完整路径。已有内容会复制并校验，原目录保留备份。" : t("companion.storage.migrationHint")}</p>
        <div className={styles.actions}>
          <button className={styles.primary} type="button" disabled={status === "saving" || !directory.trim() || directory.trim() === storage?.directory} onClick={() => void save(directory)}>{status === "saving" ? t("companion.storage.saving") : t("companion.storage.apply")}</button>
          {!scope && storage?.customized ? <button type="button" disabled={status === "saving"} onClick={() => void save(storage.defaultDirectory)}>{t("companion.storage.restoreDefault")}</button> : null}
        </div>
      </div> : null}

      {status === "saved" ? <p className={styles.success} role="status">{t("companion.storage.saved")}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p> : null}
    </section>
  );
}
