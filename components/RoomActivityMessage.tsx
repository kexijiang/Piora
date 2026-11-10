"use client";

import { memo } from "react";
import type { RoomActivity } from "@/lib/room-activity";
import type { RoomMember } from "@/lib/room-types";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import { RoomAvatar } from "./RoomUi";
import styles from "./RoomWorkspace.module.css";

export const RoomActivityMessage = memo(function RoomActivityMessage({ activity, member, cwd, hasFinalReply, onBrowser, onMention }: {
  activity: RoomActivity; member?: RoomMember; cwd?: string; hasFinalReply: boolean;
  onBrowser: (sessionId: string) => void; onMention: (name: string) => void;
}) {
  const { t } = useI18n();
  const name = member?.profile.name ?? t("roomUx.participant");
  const isStreaming = activity.status === "working";
  return <article className={styles.activityMessage} data-room-activity={activity.runId} aria-label={`${name} · ${t("roomUx.viewProcess")}`}>
    <RoomAvatar member={member} name={name} small />
    <div className={styles.activityBody}>
      <details className={styles.processDisclosure}>
        <summary><span className={styles.activityDot} data-working={isStreaming} /><strong>{name}</strong>{activity.model ? <small>{activity.model}</small> : null}<span>{isStreaming ? activity.phase : t("roomUx.processEnded")}</span><AliIcon name="chevron-right" size={15} /></summary>
        <div className={styles.processContent}>
          {activity.thinking ? <details className={styles.toolDisclosure}><summary>{t("roomUx.thinking")}</summary><MarkdownBody cwd={cwd} className="markdown-thinking">{activity.thinking}</MarkdownBody></details> : null}
          {activity.tools.map((tool) => <details key={tool.id} className={`${styles.toolDisclosure} liveTool`}>
            <summary><AliIcon name="code" size={14} /><strong>{tool.name}</strong><span className={styles.badge} data-phase={tool.status}>{t(`roomUx.phase.${tool.status === "error" ? "failed" : tool.status}`)}</span></summary>
            <pre>{tool.input}</pre>{tool.output ? <pre>{tool.output}</pre> : null}
          </details>)}
          <div className={styles.inlineActions}><button type="button" onClick={() => onMention(name)}>{t("roomUx.guide")}</button><button type="button" onClick={() => onBrowser(activity.sessionId)}><AliIcon name="earth" size={14} />{t("roomUx.browser")}</button></div>
        </div>
      </details>
      {activity.text && !hasFinalReply ? <div className={`${styles.streamingText} message-assistant-blocks`}><MarkdownBody cwd={cwd} className="markdown-assistant-message" isStreaming={isStreaming}>{activity.text}</MarkdownBody></div> : null}
    </div>
  </article>;
});
