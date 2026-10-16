"use client";

import { useEffect, useState } from "react";
import type { CompactProcessGroup } from "@/lib/compact-chat-history";
import { commandDisplayName, isCommandToolName } from "@/lib/command-execution";
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
  const description = [t("chat.processSteps", { count: group.count }), elapsed !== null ? formatStatusDuration(elapsed) : null].filter(Boolean).join(" · ");
  return <section className={`compact-process-group${group.active ? " is-active" : ""}${group.attention ? " has-attention" : ""}`}>
    <ChatDisclosureTrigger className="compact-process-toggle" expanded={group.expanded} icon="activity"
      label={t(group.attention ? "chat.processAttention" : group.active ? "chat.processWorking" : "chat.processFinished")}
      description={description} title={t(group.expanded ? "chat.collapseProcess" : "chat.expandProcess")}
      onClick={(event) => togglePreservingScroll(event.currentTarget, onToggle)} />
    {group.active && !group.expanded ? <div className="compact-process-preview" aria-label={t("chat.processPreview")}>
      {group.preview.map((step) => {
        const block = step.block;
        const command = block.type === "toolCall" && isCommandToolName(block.toolName);
        const label = block.type === "thinking" ? t("i18n.thinking")
          : block.type === "toolCall" ? command ? commandDisplayName(block.toolName) : summarizeToolDisclosure(block.toolName, block.input, undefined, t).title
            : t("chat.processUpdate");
        return <div key={step.key} className={`compact-process-step is-${step.status}`}>
          <div className="compact-process-step-line">
            <AliIcon name={step.status === "running" ? "timer" : step.status === "done" ? "check" : step.status === "error" ? "error" : "info"} size={12} />
            <span className="compact-process-step-label" title={label}>{label}</span>
            {block.type === "toolCall" ? <span className="compact-process-step-status">{t(step.status === "running" ? "command.status.running" : step.status === "unknown" ? "chat.processUnknown" : step.status === "error" ? "command.status.failed" : "chat.processStepDone")}</span> : null}
          </div>
          {step.output ? <pre className="compact-command-tail">{step.output}</pre> : null}
          {command && block.type === "toolCall" && step.status === "running" ? <button type="button" className="compact-command-expand" onClick={() => onInspectCommand(block.toolCallId)}>{t("chat.processExpandLog")}</button> : null}
        </div>;
      })}
    </div> : null}
  </section>;
}
