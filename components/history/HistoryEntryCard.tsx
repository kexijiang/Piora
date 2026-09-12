"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { HistoryDetail, HistoryNode } from "@/lib/session-history";
import { createVirtualRowState } from "@/lib/virtual-row-state";
import type { CommandExecutionData } from "@/lib/command-execution";
import { MessageView } from "../MessageView";
import { VirtualRowStateContext } from "../VirtualRowState";
import { ChatDisclosure } from "../ChatDisclosure";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { MessageImage, MessageImageViewer } from "../MessageImage";
import { messageImageUrl } from "@/lib/message-images";
import { AliIcon } from "../AliIcon";
import { useVirtualRowToggle } from "../VirtualRowState";

interface Props {
  node: HistoryNode; detail?: HistoryDetail; error?: string; selected: boolean; includeThinking: boolean;
  sessionId: string; version: string; cwd: string; store: ReturnType<typeof createVirtualRowState>;
  ensure: (id: string, retry?: boolean) => void;
  onOpenFile?: (path: string) => void; onOpenCommand: (data: CommandExecutionData) => void;
  onCopy: (id: string, selection: "entry" | "turn" | "link") => void;
  onFocus: (id: string) => void; canFocus: boolean; onFork: (id: string) => void; busy: boolean;
}

export function HistoryEntryCard(props: Props) {
  const { node, detail, ensure, store, selected, includeThinking } = props;
  useEffect(() => ensure(node.id), [ensure, node.id]);
  useEffect(() => {
    if (!selected || !detail) return;
    store.set("user-content", true);
    if (detail.message?.role === "assistant") detail.message.content.forEach((block, index) => {
      if (block.type === "toolCall") { store.set(`tool:${block.toolCallId}`, true); store.set(`command:${block.toolCallId}`, true); }
      if (block.type === "thinking" && includeThinking) store.set(`thinking:${index}`, true);
    });
    store.set("event-details", true);
  }, [detail, includeThinking, selected, store]);
  return <VirtualRowStateContext.Provider value={store}><EntryContent {...props} /></VirtualRowStateContext.Provider>;
}

function EntryContent({ node, detail, error, selected, sessionId, version, cwd, ensure, onOpenFile, onOpenCommand, onCopy, onFocus, canFocus, onFork, busy }: Props) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useVirtualRowToggle("event-details");
  const [image, setImage] = useState<{ src: string; index: number } | null>(null);
  const tools = useMemo(() => new Map((detail?.tools ?? []).map(result => [result.toolCallId, result])), [detail?.tools]);
  let content: ReactNode;
  const message = detail?.message;
  if (error) content = <div className="history-inline-error" role="alert">{error}<button type="button" onClick={() => ensure(node.id, true)}>{t("history.retry")}</button></div>;
  else if (!detail) content = <div className="history-entry-skeleton" role="status">{t("history.loadingEntry")}</div>;
  else if (message?.role === "toolResult") content = <ChatDisclosure label={message.toolName || t("history.kind.tool")} icon="activity" expanded={expanded} onExpandedChange={setExpanded}
    metadata={message.isError ? t("command.status.failed") : t("command.status.success")}>
    <pre className="tool-result-output">{message.content.filter(block => block.type === "text").map(block => block.text).join("\n")}</pre>
    {message.content.filter(block => block.type === "image").map((block, index) => <MessageImage key={index} index={index} src={messageImageUrl(block)} onOpen={() => setImage({ src: messageImageUrl(block), index })} />)}
  </ChatDisclosure>;
  else if (detail.raw && detail.raw.type !== "compaction" && detail.raw.type !== "custom_message") content = <ChatDisclosure label={t(`history.event.${detail.raw.type}`) === `history.event.${detail.raw.type}` ? detail.raw.type : t(`history.event.${detail.raw.type}`)} icon="file"
    description={node.preview} expanded={expanded} onExpandedChange={setExpanded}>
    <pre className="chat-disclosure-diagnostics">{JSON.stringify(detail.raw, null, 2)}</pre>
  </ChatDisclosure>;
  else if (message) content = <MessageView mode="history" historyVersion={version} message={message} toolResults={tools} sessionId={sessionId} entryId={node.id} cwd={cwd}
    showTimestamp={false} onOpenFile={onOpenFile} onOpenCommandExecution={onOpenCommand} />;
  else content = <pre className="chat-disclosure-diagnostics">{node.preview}</pre>;
  return <article className={`history-entry${selected ? " is-target" : ""}`} data-history-entry={node.id} tabIndex={-1}>
    <div className="history-entry-meta"><span>{t(`history.kind.${node.category}`)}</span>
      {node.failed ? <span className="history-failure">{t("command.status.failed")}</span> : null}
      <time dateTime={node.timestamp}>{new Date(node.timestamp).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
      <div className="history-entry-actions">
        <button type="button" onClick={() => onCopy(node.id, "entry")} title={t("history.copyMessage")} aria-label={t("history.copyMessage")}><AliIcon name="copy" size={13} /></button>
        <button type="button" onClick={() => onCopy(node.id, "link")} title={t("history.copyLink")} aria-label={t("history.copyLink")}><AliIcon name="link" size={13} /></button>
        <button type="button" onClick={() => onFocus(node.id)} disabled={!canFocus} title={t(canFocus ? "history.locate" : "history.outsideContext")} aria-label={t("history.locate")}><AliIcon name="arrowright" size={13} /></button>
        {node.category === "user" ? <button type="button" disabled={busy} onClick={() => onFork(node.id)} title={t(busy ? "history.busy" : "history.forkDescription")}>{t("history.fork")}</button> : null}
      </div>
    </div>
    <RenderErrorBoundary resetKey={`${node.id}:${Boolean(detail)}`} fallbackLabel={t("chat.messageRenderFailed")}>{content}</RenderErrorBoundary>
    {image ? <MessageImageViewer {...image} onClose={() => setImage(null)} /> : null}
  </article>;
}
