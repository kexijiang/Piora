"use client";
import { useClipboardI18n } from "./clipboard/useClipboardI18n";
import type { ClipboardDetail } from "@/desktop/src/clipboard-types";
import { ClipboardWorkspace } from "./clipboard/ClipboardWorkspace";

export interface ClipboardTransferEntry { title: string; content: string; kind: "text" | "image" }

export function ClipboardWorkbench({ onSave }: { onSave: (entry: ClipboardTransferEntry) => Promise<void> }) {
  const { tr } = useClipboardI18n();
  const save = async (entry: ClipboardDetail) => {
    if (entry.kind === "image") {
      if ((entry.image?.bytes ?? 0) > 8 * 1024 ** 2) throw new Error(tr("中转站单张图片上限为 8 MiB；这张图片可通过「另存为」保存。"));
      const url = await window.piDesktop!.clipboard!.historyV2!.asset(entry.id);
      const response = await fetch(url);
      if (!response.ok) throw new Error(tr("读取剪贴板图片失败。"));
      const blob = await response.blob();
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error(tr("图片转换失败。"))); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob);
      });
      await onSave({ title: entry.remark || entry.title, content, kind: "image" });
    } else {
      const content = entry.kind === "files" ? entry.files.map(file => `- ${file.name}\n  ${file.path}`).join("\n") : entry.text;
      if (!content) throw new Error(tr("这条记录没有可存入笔记的文字表示，请使用复制或另存为。"));
      await onSave({ title: entry.remark || entry.title, content, kind: "text" });
    }
  };
  return <ClipboardWorkspace onSave={save} />;
}
