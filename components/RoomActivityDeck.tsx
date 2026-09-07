"use client";

import { memo, useLayoutEffect, useRef } from "react";
import { getRoomMemberName, type CollaborationRoom } from "@/lib/room-types";
import type { RoomActivity } from "@/lib/room-activity";
import { AliIcon } from "./AliIcon";
import { useLiveOutputAutoScrollPreference } from "@/hooks/useLiveOutputAutoScrollPreference";
import styles from "./RoomWorkspace.module.css";

export const RoomActivityDeck = memo(function RoomActivityDeck({ room, activities, selectedSessionId, onSelect, onBrowser, onMention }: {
  room: CollaborationRoom;
  activities: RoomActivity[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onBrowser: (id: string) => void;
  onMention: (name: string) => void;
}) {
  const activity = selectedSessionId ? activities.find((item) => item.sessionId === selectedSessionId)
    : activities.find((item) => item.status === "working") ?? activities.at(-1);
  const member = room.members.find((item) => item.binding.sessionId === (selectedSessionId ?? activity?.sessionId));
  const outputRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const { enabled: autoScroll } = useLiveOutputAutoScrollPreference();
  useLayoutEffect(() => { followRef.current = true; }, [activity?.sessionId, activity?.runId]);
  useLayoutEffect(() => {
    if (autoScroll && followRef.current && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [activity, autoScroll]);
  return <section className={styles.teamStage} aria-label="团队执行现场">
    <div className={styles.teamMembers} aria-label="团队成员">
      {room.members.map((member) => {
        const state = activities.find((item) => item.sessionId === member.binding.sessionId);
        return <button type="button" key={member.memberId} aria-pressed={(selectedSessionId ?? activity?.sessionId) === member.binding.sessionId}
          onClick={() => onSelect(member.binding.sessionId)} className={styles.teamMember}>
          <span className={styles.statusDot} data-working={state?.status === "working" || undefined} />
          <strong>{getRoomMemberName(member)}</strong><small>{state?.phase ?? "待命"}</small>
        </button>;
      })}
    </div>
    {activity && member ? <details className={styles.liveActivity} key={`${activity.sessionId}:${activity.runId}`} open={activity.status === "working"}>
      <summary><AliIcon name="activity" size={14} /><strong>{getRoomMemberName(member)}</strong><span>{activity.phase}</span><small>查看过程</small></summary>
      <div className={styles.liveActions}>
        <button type="button" onClick={() => onMention(getRoomMemberName(member))}>补充指令</button>
        <button type="button" onClick={() => onBrowser(activity.sessionId)}><AliIcon name="earth" size={13} />查看浏览器</button>
      </div>
      <div className={styles.liveOutput} ref={outputRef} onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}>
        {activity.thinking ? <details className={styles.liveThinking} open><summary>思考过程</summary><pre>{activity.thinking}</pre></details> : null}
        {activity.tools.map((tool) => <details key={tool.id} className={styles.liveTool}>
          <summary><span data-state={tool.status}>{tool.status === "running" ? "执行中" : tool.status === "error" ? "失败" : "已完成"}</span><strong>{tool.name}</strong></summary>
          <pre>{tool.input}</pre>{tool.output ? <pre>{tool.output}</pre> : null}
        </details>)}
        {activity.text ? <pre className={styles.liveText}>{activity.text}</pre> : !activity.thinking && !activity.tools.length ? <p>等待成员输出；思考和工具活动会实时显示在这里。</p> : null}
      </div>
    </details> : member ? <div className={styles.liveActions}>
      <button type="button" onClick={() => onMention(getRoomMemberName(member))}>@{getRoomMemberName(member)} 补充指令</button>
      <button type="button" onClick={() => onBrowser(member.binding.sessionId)}>查看浏览器</button>
    </div> : <p className={styles.stageHint}>描述目标，让团队分工完成；也可以 @ 成员直接沟通。</p>}
  </section>;
});
