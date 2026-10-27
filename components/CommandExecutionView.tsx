"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { commandDisplayName, commandErrorExcerpt, type CommandExecutionData } from "@/lib/command-execution";
import { useVirtualRowToggle } from "./VirtualRowState";
import { AliIcon } from "./AliIcon";
import { ChatDisclosure, togglePreservingScroll } from "./ChatDisclosure";
import { RevealProcessCommandContext, useCompactProcess } from "./CompactProcessContext";

const CommandLogViewer = dynamic(
  () => import("./CommandLogViewer").then((module) => module.CommandLogViewer),
  { ssr: false },
);

function statusKey(status: CommandExecutionData["status"]): string {
  if (status === "running") return "command.status.running";
  if (status === "success") return "command.status.success";
  if (status === "cancelled") return "command.status.cancelled";
  if (status === "timed_out") return "command.status.timedOut";
  return "command.status.failed";
}

function commandOutputUrl(data: CommandExecutionData): string | null {
  return data.sessionId && data.fullOutputPath
    ? `/api/agent/${encodeURIComponent(data.sessionId)}/bash-output?path=${encodeURIComponent(data.fullOutputPath)}`
    : null;
}

function IconButton({ icon, label, onClick, disabled = false }: { icon: "copy" | "expand" | "search" | "arrowdown" | "code"; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="command-icon-button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <AliIcon name={icon} size={13} />
    </button>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="command-icon-button" title={copied ? t("i18n.copied") : label ?? t("command.copyCommand")} aria-label={label ?? t("command.copyCommand")}
      onClick={() => { void copyText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>
      <AliIcon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
}

function CommandOutputPanel({ data, initialSearch = "", inDialog = false }: { data: CommandExecutionData; initialSearch?: string; inDialog?: boolean }) {
  const { t } = useI18n();
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [wrap, setWrap] = useState(true);
  const [searchRequest, setSearchRequest] = useState(0);
  const [endRequest, setEndRequest] = useState(0);
  const [following, setFollowing] = useState(data.isStreaming);
  const [outputExpanded, setOutputExpanded] = useVirtualRowToggle(`command-output-height:${data.id}`);
  const [outputOverflows, setOutputOverflows] = useState(false);
  const fullUrl = commandOutputUrl(data);
  const output = data.isStreaming ? data.output : fullOutput ?? data.output;
  const isEmpty = !output.trim() || output.trim() === "(no output)";

  useEffect(() => {
    if (!initialSearch) return;
    setSearchRequest((value) => value + 1);
  }, [initialSearch]);

  async function loadFullOutput() {
    if (!fullUrl || loadingFull || data.isStreaming) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const response = await fetch(fullUrl);
      const body = await response.json() as { success?: boolean; data?: { output?: string; maxBytes?: number }; error?: string };
      if (response.status === 413) {
        const limit = Math.max(1, Math.round((body.data?.maxBytes ?? 5 * 1024 * 1024) / 1024 / 1024));
        setFullError({ message: t("command.fullOutputTooLarge", { limit }), retryable: false });
        return;
      }
      if (!response.ok || !body.success) throw new Error(body.error ?? `HTTP ${response.status}`);
      setFullOutput(body.data?.output ?? "");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setFullError({ message: `${t("command.fullOutputUnavailable")}: ${detail}`, retryable: true });
    } finally {
      setLoadingFull(false);
    }
  }

  return (
    <section className={`command-output-section${!inDialog && outputExpanded ? " is-output-expanded" : ""}`} aria-label={t("command.output")}>
      <div className="command-section-toolbar">
        <AliIcon name="code" size={14} aria-hidden="true" />
        <span className="command-section-label">{t("command.output")}</span>
        {fullOutput !== null ? <span className="command-full-loaded">{t("command.fullOutputLoaded")}</span> : null}
        <span className="command-toolbar-spacer" />
        {!isEmpty ? <>
          <IconButton icon="search" label={t("command.searchOutput")} onClick={() => setSearchRequest((value) => value + 1)} />
          <IconButton icon="code" label={t(wrap ? "command.disableWrap" : "command.enableWrap")} onClick={() => setWrap((value) => !value)} />
          <IconButton icon="arrowdown" label={t("command.jumpToEnd")} onClick={() => setEndRequest((value) => value + 1)} />
          {!inDialog && (outputExpanded || outputOverflows) ? (
            <button type="button" className="command-icon-button command-output-expand" aria-expanded={outputExpanded}
              title={t(outputExpanded ? "command.collapseOutput" : "command.expandOutput")}
              aria-label={t(outputExpanded ? "command.collapseOutput" : "command.expandOutput")}
              onClick={(event) => togglePreservingScroll(event.currentTarget, () => setOutputExpanded(!outputExpanded))}>
              <AliIcon name="chevron-right" size={13} aria-hidden="true" />
            </button>
          ) : null}
          <CopyButton text={output} label={t(data.truncated && fullOutput === null ? "command.copyCurrentOutput" : "command.copyOutput")} />
        </> : null}
      </div>
      {data.truncated && fullOutput === null ? (
        <div className="command-truncation-notice" role="status">
          <AliIcon name="alert" size={13} />
          <span>{t("command.partialOutput")}</span>
          {fullUrl && !data.isStreaming ? <button type="button" onClick={() => void loadFullOutput()} disabled={loadingFull}>{loadingFull ? t("command.loadingFullOutput") : t("command.viewFullOutput")}</button> : null}
          {fullUrl ? <a href={`${fullUrl}&download=1`}>{t("command.downloadFullOutput")}</a> : null}
          {!fullUrl ? <span>{t("command.fullOutputReferenceMissing")}</span> : null}
        </div>
      ) : null}
      {fullError ? <div className="command-full-error" role="alert">{fullError.message} {fullError.retryable ? <button type="button" onClick={() => void loadFullOutput()}>{t("command.retry")}</button> : null}</div> : null}
      {isEmpty ? (
        <div className="command-empty-output">{t(data.status === "running" ? data.historical ? "history.noSavedResult" : "command.waitingForOutput" : data.status === "success" ? "command.noOutput" : "command.noErrorOutput")}</div>
      ) : (
        <div className="command-log-frame">
          <CommandLogViewer output={output} wrap={wrap} streaming={data.isStreaming} searchText={initialSearch} searchRequest={searchRequest} endRequest={endRequest} ariaLabel={t("command.outputLog")} onFollowChange={setFollowing} onOverflowChange={setOutputOverflows} />
          {data.isStreaming && !following ? <button type="button" className="command-follow-output" onClick={() => setEndRequest((value) => value + 1)}>{t("command.backToLatest")}</button> : null}
        </div>
      )}
    </section>
  );
}

export function CommandExecutionCard({ data, onOpen, actions }: { data: CommandExecutionData; onOpen?: (data: CommandExecutionData) => void; actions?: ReactNode }) {
  const { t } = useI18n();
  const compact = useCompactProcess();
  const [expanded, setExpanded] = useVirtualRowToggle(`command:${data.id}`);
  const inspectCommand = useContext(RevealProcessCommandContext);
  useEffect(() => {
    if (inspectCommand === data.id) setExpanded(true);
  }, [inspectCommand, data.id, setExpanded]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useVirtualRowToggle(`command-diagnostics:${data.id}`);
  const diagnosticsId = useId();
  const [errorSearch, setErrorSearch] = useState("");
  const errorExcerpt = useMemo(() => data.status === "failed" || data.status === "cancelled" || data.status === "timed_out" ? commandErrorExcerpt(data.output) : "", [data.output, data.status]);
  const statusParts = [t(data.historical && data.status === "running" ? "history.noSavedResult" : statusKey(data.status))];
  if (expanded && data.exitCode !== undefined) statusParts.push(t("command.exitCode", { code: data.exitCode }));
  if (expanded && data.duration !== undefined) statusParts.push(t("command.duration", { seconds: data.duration }));

  useEffect(() => {
    if (data.historical) return;
    window.dispatchEvent(new CustomEvent<CommandExecutionData>("piora-command-execution-update", { detail: data }));
  }, [data]);

  return (
    <div className={compact ? "compact-command-card" : undefined}>
    <ChatDisclosure className={`command-execution-card is-${data.historical && data.status === "running" ? "unknown" : data.status}`}
      expanded={expanded} onExpandedChange={setExpanded} label={t("command.action.run")} icon="terminal"
      description={<span className="command-summary-preview" title={data.command}>{data.command.replace(/\s+/g, " ").trim()}</span>}
      triggerClassName="command-execution-toggle"
      metadata={<span title={statusParts.join(" · ")} aria-label={statusParts.join(" · ")} className={`chat-disclosure-status is-${data.historical && data.status === "running" ? "unknown" : data.status}`}>
        <span className="command-status-badge">
          <AliIcon name={data.status === "cancelled" ? "stop" : data.status === "timed_out" ? "timer" : data.status === "failed" ? "error" : data.status === "running" ? "timer" : "check"} size={14} aria-hidden="true" />
          {data.status === "success" && !expanded ? null : statusParts[0]}
        </span>
        {expanded && statusParts.length > 1 ? <span className="command-status-details">{statusParts.slice(1).join(" · ")}</span> : null}
      </span>}
      actions={<>
        <CopyButton text={data.command} />
        {actions ? <span className="command-message-actions">{actions}</span> : null}
        {onOpen ? <IconButton icon="expand" label={t("command.openLargeViewer")} onClick={() => onOpen(data)} /> : null}
      </>}>
      {errorExcerpt ? (
        <button type="button" className="command-error-excerpt" onClick={() => { setErrorSearch(errorExcerpt.split("\n")[0] ?? ""); setExpanded(true); }}>
          <span>{t("command.errorExcerpt")}</span><code>{errorExcerpt}</code><small>{t("command.viewErrorContext")}</small>
        </button>
      ) : null}
      <div className="command-execution-details">
        <section className="command-source-section">
          <div className="command-section-toolbar">
            <AliIcon name="terminal" size={14} aria-hidden="true" />
            <span className="command-section-label">{t("command.command")}</span>
            <span className="command-toolbar-spacer" />
            <CopyButton text={data.command} />
          </div>
          {data.cwd ? <div className="command-cwd" title={data.cwd}>{t("command.cwd")}: {data.cwd}</div> : null}
          <pre>{data.command}</pre>
        </section>
        <CommandOutputPanel data={data} initialSearch={errorSearch} />
        {data.diagnostics ? <section className="command-diagnostics-section" aria-label={t("toolSummary.diagnostics")}>
          <div className="command-section-toolbar">
            <button type="button" className="command-section-toggle" aria-expanded={diagnosticsOpen} aria-controls={diagnosticsId}
              onClick={(event) => togglePreservingScroll(event.currentTarget, () => setDiagnosticsOpen(!diagnosticsOpen))}>
              <AliIcon name="chevron-right" size={14} aria-hidden="true" />
              <span className="command-section-label">{t("toolSummary.diagnostics")}</span>
            </button>
            <CopyButton text={data.diagnostics} label={t("command.copyDiagnostics")} />
          </div>
          {diagnosticsOpen ? <pre id={diagnosticsId} className="command-diagnostics">{data.diagnostics}</pre> : null}
        </section> : null}
      </div>
    </ChatDisclosure>
    {compact && !expanded && errorExcerpt ? <div className="compact-command-error" role="status">{errorExcerpt}</div> : null}
    </div>
  );
}

export function CommandExecutionDialog({ data, onClose }: { data: CommandExecutionData; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hasDesktopChrome = typeof window !== "undefined" && Boolean(window.piDesktop);
  const close = () => { dialogRef.current?.close(); onClose(); };
  const [current, setCurrent] = useState(data);
  useEffect(() => setCurrent(data), [data]);
  useEffect(() => {
    if (data.historical) return;
    const update = (event: Event) => {
      const next = (event as CustomEvent<CommandExecutionData>).detail;
      if (next?.id === data.id) setCurrent(next);
    };
    window.addEventListener("piora-command-execution-update", update);
    return () => window.removeEventListener("piora-command-execution-update", update);
  }, [data.id, data.historical]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => { document.body.style.overflow = previousOverflow; if (dialog.open) dialog.close(); };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog ref={dialogRef} className="command-execution-dialog" aria-label={t("command.largeViewer")}
      data-desktop-chrome={hasDesktopChrome ? "true" : undefined}
      onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}>
      <div className="command-dialog-layout">
        <header className="command-dialog-header">
          <div><strong>{commandDisplayName(current.toolName)}</strong><span>{t(statusKey(current.status))}</span></div>
          <button type="button" className="command-icon-button" onClick={close} title={t("i18n.close")} aria-label={t("i18n.close")}><AliIcon name="close" size={15} /></button>
        </header>
        <section className="command-source-section command-dialog-source">
          <div className="command-section-toolbar"><AliIcon name="terminal" size={14} aria-hidden="true" /><span className="command-section-label">{t("command.command")}</span><span className="command-toolbar-spacer" /><CopyButton text={current.command} /></div>
          {current.cwd ? <div className="command-cwd" title={current.cwd}>{t("command.cwd")}: {current.cwd}</div> : null}
          <pre>{current.command}</pre>
        </section>
        <CommandOutputPanel data={current} inDialog />
      </div>
    </dialog>,
    document.body,
  );
}
