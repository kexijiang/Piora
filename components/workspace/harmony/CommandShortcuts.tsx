"use client";

import { useEffect, useRef, useState } from "react";
import { expandShortcut, mergeCommandShortcuts, normalizeCommandShortcuts, parseShortcutArchive, serializeShortcutArchive, shortcutParameters, type CommandShortcut } from "./command-shortcuts";

export function CommandShortcuts({ serial, chinese, busy, currentCommand, currentKind, currentBundleName, onFillDevice, onOpenLocalTerminal }: {
  serial: string; chinese: boolean; busy: boolean; currentCommand: string; currentKind: "shared" | "sandbox"; currentBundleName: string;
  onFillDevice: (command: string, kind: "shared" | "sandbox", bundleName: string) => void;
  onOpenLocalTerminal?: () => void;
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const key = `piora-harmony-command-shortcuts:${serial}`;
  const [shortcuts, setShortcuts] = useState<CommandShortcut[]>([]);
  const [name, setName] = useState(""), [group, setGroup] = useState(""), [command, setCommand] = useState("");
  const [target, setTarget] = useState<CommandShortcut["target"]>("device");
  const [kind, setKind] = useState<CommandShortcut["kind"]>("shared"), [bundleName, setBundleName] = useState("");
  const [favorite, setFavorite] = useState(false), [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null), [values, setValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try { setShortcuts(normalizeCommandShortcuts(JSON.parse(localStorage.getItem(key) ?? "[]"))); }
    catch { setShortcuts([]); }
    setSelectedId(null); setEditingId(null); setNotice("");
  }, [key]);
  const persist = (next: CommandShortcut[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setShortcuts(next); return true; }
    catch { setNotice(copy("无法保存快捷命令到此浏览器。", "Could not save shortcuts in this browser.")); return false; }
  };
  const resetEditor = () => { setName(""); setGroup(""); setCommand(""); setTarget("device"); setKind("shared"); setBundleName(""); setFavorite(false); setEditingId(null); };
  const save = () => {
    try {
      if (shortcuts.length >= 20 && !editingId) throw new Error(copy("最多保存 20 条快捷命令", "At most 20 shortcuts can be saved"));
      shortcutParameters(command);
      const item = normalizeCommandShortcuts([{ id: editingId ?? crypto.randomUUID(), name, group, target, command, kind, bundleName, favorite }])[0];
      if (!item) throw new Error(copy("请填写有效的名称、命令和沙箱包名", "Enter a valid name, command and sandbox bundle"));
      if (shortcuts.some(existing => existing.id !== editingId && existing.name === item.name && existing.group === item.group && existing.target === item.target)) {
        throw new Error(copy("同一组中已有同名快捷命令", "A shortcut with this name already exists in the group"));
      }
      if (persist(editingId ? shortcuts.map(existing => existing.id === editingId ? item : existing) : [...shortcuts, item])) {
        setSelectedId(item.id); setNotice(copy("快捷命令已保存；不会自动执行。", "Shortcut saved; it will not run automatically.")); resetEditor();
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const selected = shortcuts.find(item => item.id === selectedId);
  const parameters = selected ? shortcutParameters(selected.command) : [];
  let preview = "", previewError = "";
  if (selected) try { preview = expandShortcut(selected, values); } catch (error) { previewError = error instanceof Error ? error.message : String(error); }
  const applySelected = async () => {
    if (!selected || busy) return;
    try {
      const expanded = expandShortcut(selected, values);
      if (selected.target === "local") {
        if (!onOpenLocalTerminal) throw new Error(copy("本机终端在此面板不可用", "Local terminal is unavailable here"));
        await navigator.clipboard.writeText(expanded);
        onOpenLocalTerminal();
        setNotice(copy("命令已复制；请在本机终端检查并手动粘贴执行。", "Command copied; review and paste it manually in the local terminal."));
      } else {
        onFillDevice(expanded, selected.kind, selected.bundleName ?? "");
        setNotice(copy("命令已填入；请检查后手动执行。", "Command filled; review it and run manually."));
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error(copy("快捷命令文件超过 256 KiB", "Shortcut file exceeds 256 KiB"));
      const incoming = parseShortcutArchive(await file.text());
      const merged = mergeCommandShortcuts(shortcuts, incoming, () => crypto.randomUUID());
      if (persist(merged.shortcuts)) setNotice(copy(`已导入 ${merged.added} 条，跳过 ${merged.skipped} 条同名命令；不会自动执行。`, `Imported ${merged.added}; skipped ${merged.skipped} duplicate names. Nothing ran automatically.`));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (importRef.current) importRef.current.value = ""; }
  };
  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([serializeShortcutArchive(shortcuts)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "piora-harmony-shortcuts.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const groups = [...new Set(shortcuts.map(item => item.group))].sort((a, b) => a.localeCompare(b));
  return <details><summary>{copy("快捷命令", "Command shortcuts")}</summary>
    <p>{copy("只在此电脑保存；导入和选择不会自动执行。参数会显示展开后的命令，执行前请检查。", "Saved on this computer only. Importing or selecting never runs a command. Review the expanded command before execution.")}</p>
    <div><button disabled={busy || !currentCommand.trim()} onClick={() => { setCommand(currentCommand); setKind(currentKind); setBundleName(currentBundleName); }}>{copy("使用当前命令作为模板", "Use current command as template")}</button>
      <button disabled={busy} onClick={() => importRef.current?.click()}>{copy("导入", "Import")}</button>
      <button disabled={busy || !shortcuts.length} onClick={exportFile}>{copy("导出", "Export")}</button>
      <input ref={importRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={event => void importFile(event.target.files?.[0])} /></div>
    <label>{copy("名称", "Name")}<input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
    <label>{copy("分组", "Group")}<input value={group} maxLength={40} onChange={event => setGroup(event.target.value)} /></label>
    <label>{copy("执行目标", "Target")}<select value={target} onChange={event => setTarget(event.target.value as CommandShortcut["target"])}>
      <option value="device">{copy("鸿蒙设备", "Harmony device")}</option>{onOpenLocalTerminal ? <option value="local">{copy("本机终端", "Local terminal")}</option> : null}
    </select></label>
    {target === "device" ? <><label>{copy("设备范围", "Device scope")}<select value={kind} onChange={event => setKind(event.target.value as CommandShortcut["kind"])}>
      <option value="shared">{copy("设备 Shell", "Device shell")}</option><option value="sandbox">{copy("调试沙箱", "Debug sandbox")}</option>
    </select></label>{kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}</> : null}
    <label>{copy("命令模板（参数如 {{name}}）", "Command template (parameters like {{name}})")}
      <textarea rows={3} maxLength={8192} style={{ width: "100%" }} value={command} onChange={event => setCommand(event.target.value)} /></label>
    <label><input type="checkbox" checked={favorite} onChange={event => setFavorite(event.target.checked)} />{copy("收藏", "Favorite")}</label>
    <button disabled={busy || !name.trim() || !command.trim() || (target === "device" && kind === "sandbox" && !bundleName.trim())} onClick={save}>{editingId ? copy("更新快捷命令", "Update shortcut") : copy("保存快捷命令", "Save shortcut")}</button>
    {editingId ? <button onClick={resetEditor}>{copy("取消编辑", "Cancel edit")}</button> : null}
    {groups.map(value => <section key={value}><h4>{value || copy("未分组", "Ungrouped")}</h4><ul>
      {shortcuts.filter(item => item.group === value).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)).map(item => <li key={item.id}>
        <button disabled={busy} aria-label={item.favorite ? copy(`取消收藏 ${item.name}`, `Unfavorite ${item.name}`) : copy(`收藏 ${item.name}`, `Favorite ${item.name}`)} onClick={() => persist(shortcuts.map(other => other.id === item.id ? { ...other, favorite: !other.favorite } : other))}>{item.favorite ? "★" : "☆"}</button>
        <button disabled={busy} onClick={() => { setSelectedId(item.id); setValues({}); if (item.target === "device" && !shortcutParameters(item.command).length) onFillDevice(item.command, item.kind, item.bundleName ?? ""); }}>{item.name}</button>
        <span> · {item.target === "local" ? copy("本机", "Local") : item.kind === "sandbox" ? copy("沙箱", "Sandbox") : copy("设备", "Device")}</span>
        <button disabled={busy} onClick={() => { setEditingId(item.id); setName(item.name); setGroup(item.group); setCommand(item.command); setTarget(item.target); setKind(item.kind); setBundleName(item.bundleName ?? ""); setFavorite(item.favorite); }}>{copy("编辑", "Edit")}</button>
        <button disabled={busy} aria-label={copy(`删除快捷命令 ${item.name}`, `Delete shortcut ${item.name}`)} onClick={() => { persist(shortcuts.filter(other => other.id !== item.id)); if (selectedId === item.id) setSelectedId(null); if (editingId === item.id) resetEditor(); }}>×</button>
      </li>)}</ul></section>)}
    {selected ? <div><h4>{copy("展开预览", "Expanded preview")}: {selected.name}</h4>
      {parameters.map(parameter => <label key={parameter}>{parameter}<input value={values[parameter] ?? ""} maxLength={256} onChange={event => setValues(current => ({ ...current, [parameter]: event.target.value }))} /></label>)}
      <p>{selected.target === "local" ? copy("目标：本机终端（仅复制）", "Target: local terminal (copy only)") : selected.kind === "sandbox" ? `${copy("目标：调试沙箱", "Target: debug sandbox")} ${selected.bundleName}` : copy("目标：设备 Shell", "Target: device shell")}</p>
      {preview ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview}</pre> : <p>{previewError}</p>}
      <button disabled={busy || !!previewError || (selected.target === "local" && !onOpenLocalTerminal)} onClick={() => void applySelected()}>{selected.target === "local" ? copy("复制并打开本机终端", "Copy and open local terminal") : copy("填入设备命令", "Fill device command")}</button>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </details>;
}
