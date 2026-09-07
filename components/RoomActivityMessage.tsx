"use client";
import { memo } from "react";
import type { RoomActivity } from "@/lib/room-activity";
import { getRoomMemberName, type RoomMember } from "@/lib/room-types";
import { AliIcon } from "./AliIcon";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./RoomWorkspace.module.css";

export const RoomActivityMessage = memo(function RoomActivityMessage({ activity, member, cwd, hasFinalReply, onBrowser, onMention }: {
  activity: RoomActivity; member?: RoomMember; cwd?: string; hasFinalReply: boolean;
  onBrowser: (sessionId: string) => void; onMention: (name: string) => void;
}) {
  const name = member ? getRoomMemberName(member) : "智能体";
  return <article className={`${styles.message} ${styles.activityMessage}`} data-room-activity={activity.runId} aria-label={`${name}的执行过程`}>
    <span className={styles.avatar}>{name.slice(0, 1)}</span>
    <div className={styles.messageColumn}>
      <div className={styles.messageMeta}><strong>{name}</strong><span>{activity.phase}</span></div>
      <div className={styles.activityBody}>
        {activity.thinking ? <details className={styles.liveThinking}><summary>思考过程</summary><pre>{activity.thinking}</pre></details> : null}
        {activity.tools.map((tool) => <details key={tool.id} className={styles.liveTool}>
          <summary><span data-state={tool.status}>{tool.status === "running" ? activity.status === "working" ? "执行中" : "未完成" : tool.status === "error" ? "失败" : "已完成"}</span><strong>{tool.name}</strong></summary>
          <pre>{tool.input}</pre>{tool.output ? <pre>{tool.output}</pre> : null}
        </details>)}
        {activity.text && !hasFinalReply ? <MarkdownBody cwd={cwd} className="markdown-assistant-message">{activity.text}</MarkdownBody> : null}
        {!activity.text && !activity.thinking && !activity.tools.length ? <p className={styles.stageHint}>正在处理，执行步骤会显示在这里。</p> : null}
      </div>
      <div className={styles.liveActions}>
        <button type="button" onClick={() => onMention(name)}>补充指令</button>
        <button type="button" onClick={() => onBrowser(activity.sessionId)}><AliIcon name="earth" size={13} />查看浏览器</button>
      </div>
    </div>
  </article>;
});
