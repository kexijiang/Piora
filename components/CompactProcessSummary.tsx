"use client";

import { useEffect, useState } from "react";
import type { CompactProcessGroup } from "@/lib/compact-chat-history";
import { isCommandToolName } from "@/lib/command-execution";
import { toolActivityIcons, toolActivityKind } from "@/lib/tool-activity";
import { summarizeToolDisclosure } from "@/lib/tool-summary";
import { formatStatusDuration } from "@/lib/status-duration";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { ChatDisclosureTrigger, togglePreservingScroll } from "./ChatDisclosure";

export function CompactProcessSummary({ group, onToggle, onInspectCommand }: { group: CompactProcessGroup; onToggle: () => void; onInspectCommand: (id: string) => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!group.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [group.active]);
  const end = group.active ? Math.max(now, group.startedAt ?? now) : group.endedAt;
  const elapsed = group.startedAt !== undefined && end !== undefined ? Math.max(0, end - group.startedAt) : null;
  const description = Object.entries(group.activities).map(([kind, count]) => t(`chat.processActivity.${kind}` as "chat.processActivity.read", { count: count! })).join(" · ");
  return <section className={`compact-process-group${group.active ? " is-active" : ""}${group.attention ? " has-attention" : ""}`}>
    <ChatDisclosureTrigger className="compact-process-toggle" expanded={group.expanded} disabled={group.attention} icon="activity"
      label={t(group.attention ? "chat.processAttention" : group.active ? "chat.processWorking" : "chat.processFinished")}
      description={description} metadata={elapsed !== null ? formatStatusDuration(elapsed) : undefined}
      title={t(group.attention ? "chat.processAttention" : group.expanded ? "chat.collapseProcess" : "chat.expandProcess")}
      onClick={(event) => togglePreservingScroll(event.currentTarget, onToggle)} />
    {group.active && !group.expanded ? <div className="compact-process-preview" aria-label={t("chat.processPreview")}>
      {group.preview.map((step) => {
        const block = step.block;
        const command = block.type === "toolCall" && isCommandToolName(block.toolName);
        const summary = block.type === "toolCall" ? summarizeToolDisclosure(block.toolName, block.input, undefined, t) : undefined;
        const detail = block.type === "toolCall" ? command ? String(block.input.command ?? "") : summary?.subject ?? summary?.detail : undefined;
        const label = block.type === "thinking" ? t("i18n.thinking")
          : block.type === "toolCall" ? command ? t("command.action.run") : summarizeToolDisclosure(block.toolName, block.input, undefined, t).title
            : t("chat.processUpdate");
        return <div key={step.key} className={`compact-process-step is-${step.status}`}>
          <div className="compact-process-step-line">
            <AliIcon name={block.type === "thinking" ? "brain" : block.type === "toolCall" ? toolActivityIcons[toolActivityKind(block.toolName)] : "info"} size={14} />
            <span className="compact-process-step-label" title={label}>{label}</span>
            {detail ? <span className="compact-process-step-detail" title={detail}>{detail}</span> : null}
            {block.type === "toolCall" ? <span className="compact-process-step-status">{t(step.status === "running" ? "command.status.running" : step.status === "unknown" ? "chat.processUnknown" : step.status === "error" ? "command.status.failed" : "chat.processStepDone")}</span> : null}
          </div>
          {command && block.type === "toolCall" && step.status === "running" ? <button type="button" className="compact-command-expand" onClick={() => onInspectCommand(block.toolCallId)}>{t("chat.processExpandLog")}</button> : null}
        </div>;
      })}
    </div> : null}
  </section>;
}
