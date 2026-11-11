// Browser streaming adapted from dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
type SaveMode = "saved" | "download";
type WritableFile = { write(value: Uint8Array | Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type SavePicker = (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableFile> }>;
type PickerWindow = Window & { showSaveFilePicker?: SavePicker };

const BUFFER_LIMIT = 8 * 1024 * 1024;

function picker(): SavePicker | undefined {
  // Electron intentionally denies renderer filesystem writes. Its ordinary
  // download flow saves through the native dialog without granting that API.
  return window.piDesktop ? undefined : (window as PickerWindow).showSaveFilePicker?.bind(window);
}

function startDownload(url: string, name: string): void {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin
    || (target.protocol !== "blob:" && !target.pathname.startsWith("/api/harmony/"))) {
    throw new Error("只能下载当前应用提供的设备文件");
  }
  const link = document.createElement("a");
  link.href = target.href; link.download = name;
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); }
}

function downloadBlob(blob: Blob, name: string): SaveMode {
  const url = URL.createObjectURL(blob);
  try { startDownload(url, name); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
  return "download";
}

/** Desktop streams the authenticated same-origin response directly to disk. */
export async function exportFilteredLogs(url: string): Promise<SaveMode> {
  const name = "filtered-logs.jsonl";
  if (window.piDesktop) { startDownload(url, name); return "download"; }
  let output: WritableFile | undefined;
  try {
    const choose = picker();
    if (choose) output = await (await choose({ suggestedName: name })).createWritable();
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "日志导出失败");
    if (!response.body) throw new Error("日志导出没有返回内容");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (output) await output.write(value);
        else {
          bytes += value.byteLength;
          if (bytes > BUFFER_LIMIT) throw new Error("浏览器不支持流式保存，筛选结果超过 8 MiB；请收窄过滤，或从本机目录读取完整文件。");
          chunks.push(value);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (output) { await output.close(); output = undefined; return "saved"; }
    return downloadBlob(new Blob(chunks as BlobPart[], { type: "application/x-ndjson" }), name);
  } catch (failure) { await output?.abort().catch(() => {}); throw failure; }
}

export async function saveLogSnapshot(file: File): Promise<SaveMode> {
  const choose = picker();
  if (!choose) return downloadBlob(file, file.name);
  const output = await (await choose({ suggestedName: file.name })).createWritable();
  try { await output.write(file); await output.close(); return "saved"; }
  catch (failure) { await output.abort().catch(() => {}); throw failure; }
}
