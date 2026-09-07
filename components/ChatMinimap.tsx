"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { minimapPreviewTop } from "@/lib/minimap-position";
import { useI18n } from "@/hooks/useI18n";
import type { AgentMessage, TextContent, UserMessage } from "@/lib/types";
import { AliIcon } from "./AliIcon";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import styles from "./ChatMinimap.module.css";

interface Props {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  onRevealHistory: (userIndex: number) => void;
}
const TIMELINE_PINNED_STORAGE_KEY = "piora:chat-timeline-pinned:v1";
function getUserPreview(message: UserMessage): string {
  // Content blocks restored from older session files can be missing or hold
  // non-string text; flatten defensively so the minimap can never crash the
  // whole renderer for one malformed message.
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .filter((block): block is TextContent => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join(" ")
      : "";
  return content.replace(/\s+/g, " ").trim();
}


export const ChatMinimap = memo(function ChatMinimap({ messages, scrollContainer, onRevealHistory }: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(600);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState(16);
  const [previewHeight, setPreviewHeight] = useState(0);
  const previewBox = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const previewList = useRef<HTMLDivElement>(null);
  const previewHandle = useRef<VirtualListHandle>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeLock = useRef(0);
  const users = useMemo(() => {
    const result: string[] = [];
    for (const message of messages) {
      if (message.role !== "user") continue;
      result.push(getUserPreview(message));
    }
    return result;
  }, [messages]);
  const keys = useMemo(() => users.map((_, index) => String(index)), [users]);
  const sampledIndices = useMemo(() => {
    const capacity = Math.max(2, Math.floor((height - 32) / 18));
    const count = Math.min(users.length, capacity);
    const samples = new Set<number>();
    for (let i = 0; i < count; i++) samples.add(count === 1 ? 0 : Math.round(i * (users.length - 1) / (count - 1)));
    if (users.length) samples.add(Math.min(activeIndex, users.length - 1));
    return [...samples].sort((a, b) => a - b);
  }, [activeIndex, height, users.length]);
  useEffect(() => {
    try { setPreviewPinned(localStorage.getItem(TIMELINE_PINNED_STORAGE_KEY) === "true"); } catch { /* Optional preference. */ }
  }, []);
  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setVisible(users.length > 0 && scrollEl.scrollHeight > scrollEl.clientHeight + 20);
      if (root.current) setHeight(root.current.clientHeight);
      if (Date.now() < activeLock.current) return;
      const focus = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.3;
      let closest: number | undefined;
      let distance = Infinity;
      // Only mounted user rows are measured. No full-history scan on scroll.
      for (const element of scrollEl.querySelectorAll<HTMLElement>("[data-chat-user-index]")) {
        const nextDistance = Math.abs(element.getBoundingClientRect().top - focus);
        if (nextDistance < distance) { distance = nextDistance; closest = Number(element.dataset.chatUserIndex); }
      }
      if (closest !== undefined) setActiveIndex(closest);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollEl);
    if (scrollEl.firstElementChild) observer.observe(scrollEl.firstElementChild);
    const mutation = new MutationObserver(schedule);
    mutation.observe(scrollEl, { childList: true, subtree: true });
    update();
    return () => { observer.disconnect(); mutation.disconnect(); scrollEl.removeEventListener("scroll", schedule); if (frame) cancelAnimationFrame(frame); };
  }, [scrollContainer, users.length, visible]);
  useEffect(() => { if ((previewOpen || previewPinned) && users.length) previewHandle.current?.scrollToKey(String(activeIndex)); }, [activeIndex, previewOpen, previewPinned, users.length]);
  useEffect(() => () => { clearTimeout(hideTimer.current); }, []);
  useLayoutEffect(() => {
    const box = previewBox.current;
    if (!box) return;
    const measure = () => setPreviewHeight(box.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [previewOpen, previewPinned, users.length]);
  const scrollToNode = useCallback((index: number) => {
    const target = Math.max(0, Math.min(users.length - 1, index));
    activeLock.current = Date.now() + 1_000;
    setActiveIndex(target);
    onRevealHistory(target);
    // A completed jump should expose the message's controls. A pinned preview
    // remains visible through previewPinned, while transient hover UI closes.
    setPreviewOpen(false);
  }, [onRevealHistory, users.length]);
  const showPreview = () => { clearTimeout(hideTimer.current); setPreviewOpen(true); };
  const hidePreview = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setPreviewOpen(false), 180); };
  if (!visible) return null;
  return <div ref={root} className={styles.root} data-testid="chat-timeline" onMouseEnter={(event) => { if (!previewPinned && root.current && event.clientX >= root.current.getBoundingClientRect().left) setPreviewAnchor(event.clientY - root.current.getBoundingClientRect().top); showPreview(); }} onMouseMove={(event) => { if (!previewPinned && event.target instanceof Element && !event.target.closest("[data-minimap-preview-box], [data-minimap-preview-bridge]") && root.current) setPreviewAnchor(event.clientY - root.current.getBoundingClientRect().top); }} onMouseLeave={hidePreview} onFocusCapture={(event) => { if (!previewPinned && root.current && !previewBox.current?.contains(event.target)) setPreviewAnchor(event.target.getBoundingClientRect().top - root.current.getBoundingClientRect().top + 7); showPreview(); }}
      onBlurCapture={(event) => { if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) hidePreview(); }}>
    <div className={styles.track} style={{ top: 16, height: Math.max(1, Math.min(height - 32, (users.length - 1) * 44)) }} aria-hidden="true" />
    {sampledIndices.map((index) => <button key={index} type="button" className={styles.node} data-minimap-node-index={index} data-minimap-node-active={activeIndex === index ? "true" : undefined}
      aria-current={activeIndex === index ? "true" : undefined} aria-label={t("chat.timelineJump", { index: index + 1, text: users[index] || t("chat.timelineAttachmentOnly") })}
      title={users[index] || t("chat.timelineAttachmentOnly")} onClick={() => scrollToNode(index)}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); scrollToNode(activeIndex + (event.key === "ArrowDown" ? 1 : -1)); } }}
      style={{ top: 16 + index * Math.min(44, (height - 32) / Math.max(1, users.length - 1)), height: 14 }}><span className={styles.dot} aria-hidden="true" /></button>)}
    {previewOpen || previewPinned ? <><div data-minimap-preview-bridge="" className={styles.previewBridge} style={{ top: minimapPreviewTop(previewAnchor, previewHeight, height), height: previewHeight }} onMouseEnter={showPreview} /><div ref={previewBox} onMouseEnter={showPreview} onMouseLeave={hidePreview} className={styles.preview} style={{ top: minimapPreviewTop(previewAnchor, previewHeight, height) }} data-minimap-preview-box="" data-pinned={previewPinned ? "true" : undefined}>
      <div className={styles.previewHeader}><div className={styles.previewHeading}><span className={styles.previewTitle}>{t("chat.timeline")}</span><span className={styles.previewCount}>{t("chat.timelineCount", { count: users.length })}</span></div>
        <button type="button" className={styles.pinButton} data-active={previewPinned ? "true" : undefined} aria-pressed={previewPinned} aria-label={t(previewPinned ? "chat.timelineUnpin" : "chat.timelinePin")}
          onClick={() => { const next = !previewPinned; setPreviewPinned(next); try { localStorage.setItem(TIMELINE_PINNED_STORAGE_KEY, String(next)); } catch { /* Optional preference. */ } }}><AliIcon name="pushpin" size={14} /></button>
      </div>
      <div ref={previewList} className={styles.previewList}>
        <VirtualList keys={keys} estimate={38} scrollContainer={previewList} handleRef={previewHandle} renderItem={(_key, index) =>
          <button type="button" className={styles.previewItem} data-minimap-preview-user={index} data-active={activeIndex === index ? "true" : undefined} aria-current={activeIndex === index ? "true" : undefined}
            title={users[index]} onClick={() => scrollToNode(index)}><span className={styles.previewNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className={styles.previewText}>{users[index] || t("chat.timelineAttachmentOnly")}</span></button>} />
      </div>
    </div></> : null}
  </div>;
});
