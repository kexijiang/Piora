"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from "react";
import type { RoomMessage } from "@/lib/room-types";
import { useI18n } from "@/hooks/useI18n";
import { getRoomMessagePreview } from "@/lib/room-message-navigation";
import { AliIcon } from "./AliIcon";
import styles from "./ChatMinimap.module.css";

const MAX_NODE_GAP = 44;
const MINIMAP_PADDING = 16;
const PREVIEW_HIDE_DELAY = 180;
const TIMELINE_PINNED_STORAGE_KEY = "piora:chat-timeline-pinned:v1";

interface NavigatorNode {
  id: string;
  index: number;
  preview: string;
  scrollTop: number | null;
  topRatio: number;
}

interface Props {
  messages: RoomMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<Map<string, HTMLElement>>;
}

function positionNodes(nodes: NavigatorNode[], height: number): { nodes: NavigatorNode[]; gap: number } {
  if (nodes.length === 0) return { nodes: [], gap: MAX_NODE_GAP };
  const safeHeight = Math.max(1, height);
  const usableHeight = Math.max(0, safeHeight - MINIMAP_PADDING * 2);
  const gap = nodes.length === 1 ? MAX_NODE_GAP : Math.min(MAX_NODE_GAP, usableHeight / (nodes.length - 1));
  return {
    gap,
    nodes: nodes.map((node, index) => ({
      ...node,
      topRatio: (MINIMAP_PADDING + index * gap) / safeHeight,
    })),
  };
}

export function RoomMessageNavigator({ messages, scrollContainer, messageRefs }: Props) {
  const { t } = useI18n();
  // Timeline tracks user prompts only; agent replies and system entries stay out of the log.
  const userMessages = useMemo(
    () => messages.filter((message) => message.author.kind === "user"),
    [messages],
  );
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NavigatorNode[]>([]);
  const [height, setHeight] = useState(600);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPinned, setPreviewPinned] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewListRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLButtonElement>());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationLockRef = useRef<{ index: number; until: number } | null>(null);

  useEffect(() => {
    try {
      const pinned = localStorage.getItem(TIMELINE_PINNED_STORAGE_KEY) === "true";
      setPreviewPinned(pinned);
      if (pinned) setPreviewOpen(true);
    } catch {
      // Keep the default when local storage is unavailable.
    }
  }, []);

  const positioned = useMemo(() => positionNodes(nodes, height), [height, nodes]);

  const syncActive = useCallback((scrollEl: HTMLDivElement, candidates: NavigatorNode[]) => {
    const lock = navigationLockRef.current;
    if (lock && Date.now() < lock.until) {
      setActiveIndex(lock.index);
      return;
    }
    navigationLockRef.current = null;
    const measured = candidates.filter((node) => node.scrollTop !== null);
    if (measured.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const closest = measured.reduce((best, node) => (
      Math.abs((node.scrollTop ?? 0) - focusTop) < Math.abs((best.scrollTop ?? 0) - focusTop) ? node : best
    ), measured[0]);
    setActiveIndex(closest.index);
  }, []);

  const measure = useCallback(() => {
    const scrollEl = scrollContainer.current;
    const minimapEl = containerRef.current;
    if (!scrollEl) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const nextNodes = userMessages.map((message, index): NavigatorNode => {
      const element = messageRefs.current.get(message.id);
      const elementRect = element?.getBoundingClientRect();
      return {
        id: message.id,
        index,
        preview: getRoomMessagePreview(message),
        scrollTop: elementRect ? elementRect.top - containerRect.top + scrollEl.scrollTop : null,
        topRatio: 0,
      };
    });
    setHeight(minimapEl?.clientHeight || scrollEl.clientHeight);
    setNodes(nextNodes);
    setVisible(nextNodes.length > 1 && scrollEl.scrollHeight - scrollEl.clientHeight > 20);
    syncActive(scrollEl, nextNodes);
  }, [messageRefs, scrollContainer, syncActive, userMessages]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const handleScroll = () => syncActive(scrollEl, nodes);
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", handleScroll);
  }, [nodes, scrollContainer, syncActive]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const timer = window.setTimeout(measure, 60);
    if (typeof ResizeObserver === "undefined") return () => window.clearTimeout(timer);
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    if (scrollEl.firstElementChild) observer.observe(scrollEl.firstElementChild);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [measure, userMessages.length, scrollContainer]);

  const scrollToNode = useCallback((node: NavigatorNode) => {
    const scrollEl = scrollContainer.current;
    const target = messageRefs.current.get(node.id);
    if (!scrollEl || !target) return;
    navigationLockRef.current = { index: node.index, until: Date.now() + 1_400 };
    setActiveIndex(node.index);
    scrollEl.scrollTo({
      top: Math.max(0, target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - scrollEl.clientTop - scrollEl.clientHeight * 0.3),
      behavior: "instant",
    });
    setPreviewOpen(false);
  }, [messageRefs, scrollContainer]);

  const cancelHide = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);
  const showPreview = useCallback(() => {
    cancelHide();
    setPreviewOpen(true);
  }, [cancelHide]);
  const scheduleHide = useCallback(() => {
    if (previewPinned) return;
    cancelHide();
    hideTimerRef.current = setTimeout(() => setPreviewOpen(false), PREVIEW_HIDE_DELAY);
  }, [cancelHide, previewPinned]);
  const togglePreviewPinned = useCallback(() => {
    setPreviewPinned((current) => {
      const next = !current;
      try {
        localStorage.setItem(TIMELINE_PINNED_STORAGE_KEY, String(next));
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
      if (next) {
        cancelHide();
        setPreviewOpen(true);
      }
      return next;
    });
  }, [cancelHide]);
  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => () => cancelHide(), [cancelHide]);
  useEffect(() => {
    if (!previewOpen || activeIndex === null) return;
    const list = previewListRef.current;
    const item = previewItemRefs.current.get(activeIndex);
    if (!list || !item) return;
    list.scrollTop = Math.max(0, item.offsetTop - (list.clientHeight - item.offsetHeight) / 2);
  }, [activeIndex, previewOpen]);

  if (!visible) return null;
  const lastTop = positioned.nodes.at(-1)?.topRatio ? positioned.nodes.at(-1)!.topRatio * height : MINIMAP_PADDING;

  return <div
    ref={containerRef}
    className={styles.root}
    data-testid="room-message-timeline"
    onMouseEnter={showPreview}
    onMouseLeave={scheduleHide}
    onFocusCapture={showPreview}
    onBlurCapture={handleBlur}
  >
    <div className={styles.track} style={{ top: MINIMAP_PADDING, height: Math.max(1, lastTop - MINIMAP_PADDING) }} aria-hidden="true" />
    {positioned.nodes.map((node) => <button
      key={node.id}
      type="button"
      className={styles.node}
      data-minimap-node-active={activeIndex === node.index ? "true" : undefined}
      aria-current={activeIndex === node.index ? "true" : undefined}
      aria-label={`跳转到第 ${node.index + 1} 条消息：${node.preview}`}
      title={node.preview}
      onClick={() => scrollToNode(node)}
      style={{ top: `${node.topRatio * 100}%`, height: Math.max(14, positioned.gap) }}
    ><span className={styles.dot} aria-hidden="true" /></button>)}
    {previewOpen || previewPinned ? <div className={styles.preview} data-minimap-preview-box="" data-pinned={previewPinned ? "true" : undefined}>
      <div className={styles.previewHeader}>
        <div className={styles.previewHeading}>
          <span className={styles.previewTitle}>群聊记录</span>
          <span className={styles.previewCount}>{nodes.length} 条消息</span>
        </div>
        <button
          type="button"
          className={styles.pinButton}
          data-active={previewPinned ? "true" : undefined}
          aria-pressed={previewPinned}
          aria-label={t(previewPinned ? "chat.timelineUnpin" : "chat.timelinePin")}
          title={t(previewPinned ? "chat.timelineUnpin" : "chat.timelinePin")}
          onClick={togglePreviewPinned}
        >
          <AliIcon name="pushpin" size={14} />
        </button>
      </div>
      <div ref={previewListRef} className={styles.previewList}>
        {nodes.map((node) => <button
          key={node.id}
          ref={(element) => {
            if (element) previewItemRefs.current.set(node.index, element);
            else previewItemRefs.current.delete(node.index);
          }}
          type="button"
          className={styles.previewItem}
          data-active={activeIndex === node.index ? "true" : undefined}
          aria-current={activeIndex === node.index ? "true" : undefined}
          title={node.preview}
          onClick={() => scrollToNode(node)}
        >
          <span className={styles.previewNumber} aria-hidden="true">{String(node.index + 1).padStart(2, "0")}</span>
          <span className={styles.previewText}>{node.preview}</span>
        </button>)}
      </div>
    </div> : null}
  </div>;
}
