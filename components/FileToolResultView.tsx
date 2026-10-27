"use client";

import type { ReactNode } from "react";
import type { FileResultLine, FileToolResult } from "@/lib/file-tool-result";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { DisclosurePath, togglePreservingScroll } from "./ChatDisclosure";
import { useVirtualRowToggle } from "./VirtualRowState";

function PreviewRows<T>({ items, stateKey, render }: { items: T[]; stateKey: string; render: (item: T, index: number) => ReactNode }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useVirtualRowToggle(stateKey);
  const long = items.length > 8;
  return <>
    {items.map((item, index) => {
      if (!expanded && long && index >= 4 && index < items.length - 4) return index === 4
        ? <button key="more" className="file-tool-more" type="button" aria-expanded={false}
          onClick={event => togglePreservingScroll(event.currentTarget, () => setExpanded(true))}>{t("fileTool.showMore", { count: items.length - 8 })}</button> : null;
      return <div key={index}>{render(item, index)}</div>;
    })}
    {expanded && long ? <button className="file-tool-more" type="button" aria-expanded={true}
      onClick={event => togglePreservingScroll(event.currentTarget, () => setExpanded(false))}>{t("fileTool.showLess")}</button> : null}
  </>;
}

function FileLabel({ path, openPath, onOpenFile, directory = false }: { path: string; openPath?: string; onOpenFile?: (path: string) => void; directory?: boolean }) {
  const content = <><AliIcon name={directory ? "folder" : "file"} size={14} /><DisclosurePath path={path} /></>;
  return onOpenFile && openPath && !directory
    ? <button type="button" className="file-tool-path" title={path} aria-label={path} onClick={() => onOpenFile(openPath)}>{content}</button>
    : <span className="file-tool-path" title={path}>{content}</span>;
}

function Lines({ lines, stateKey }: { lines: FileResultLine[]; stateKey: string }) {
  return <div className="file-tool-lines"><PreviewRows items={lines} stateKey={stateKey} render={line =>
    <div className={`file-tool-line${line.match ? " is-match" : ""}`}><span className="file-tool-line-number">{line.number}</span><code>{line.text || "\u00a0"}</code></div>} /></div>;
}

/** Saved result snapshots only: expanding this view does not read or execute anything. */
export function FileToolResultView({ model, toolCallId, onOpenFile }: { model: FileToolResult; toolCallId: string; onOpenFile?: (path: string) => void }) {
  const { t } = useI18n();
  const key = `file-result:${toolCallId}`;
  return <section className="file-tool-result" data-file-result={model.kind}>
    {model.kind === "read" ? <>
      <header><FileLabel path={model.path} openPath={model.openPath} onOpenFile={onOpenFile} /><span>{t("fileTool.lines", { count: model.lines.length })}</span></header>
      {model.lines.length ? <Lines lines={model.lines} stateKey={key} /> : <p className="file-tool-empty">{t("fileTool.emptyFile")}</p>}
    </> : model.kind === "grep" ? <>
      <header>{t("fileTool.searchFiles", { count: model.groups.length })}</header>
      {model.groups.length ? <PreviewRows items={model.groups} stateKey={key} render={(group, index) => <div className="file-tool-search-group">
        <FileLabel path={group.path} openPath={group.openPath} onOpenFile={onOpenFile} />
        <Lines lines={group.lines} stateKey={`${key}:${index}`} />
      </div>} /> : <p className="file-tool-empty">{t("fileTool.noMatches")}</p>}
    </> : <>
      <header>{t("fileTool.entries", { count: model.entries.length })}</header>
      {model.entries.length ? <div className="file-tool-list"><PreviewRows items={model.entries} stateKey={key} render={entry =>
        <FileLabel {...entry} onOpenFile={onOpenFile} />} /></div> : <p className="file-tool-empty">{t(model.kind === "ls" ? "fileTool.emptyDirectory" : "fileTool.noMatches")}</p>}
    </>}
    {model.notice ? <p className="file-tool-notice">{model.notice}</p> : null}
  </section>;
}
