export interface ScrollToBottomVisibilityInput {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  transientTailHeight?: number;
  threshold: number;
}

export interface ContentScrollMetricsInput {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  transientTailHeight?: number;
}

export interface ContentScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  maxScrollTop: number;
}

export interface LiveTailScrollLimitInput extends ContentScrollMetricsInput {
  pinnedScrollTop?: number | null;
}

/**
 * Normalize native scroll metrics to the height of actual conversation
 * content. The live-tail spacer may extend the browser's scroll range while
 * an agent is running, but controls must not expose that empty range.
 */
export function getContentScrollMetrics({
  scrollHeight,
  scrollTop,
  clientHeight,
  transientTailHeight = 0,
}: ContentScrollMetricsInput): ContentScrollMetrics {
  const contentScrollHeight = Math.max(0, scrollHeight - Math.max(0, transientTailHeight));
  const maxScrollTop = Math.max(0, contentScrollHeight - Math.max(0, clientHeight));
  return {
    scrollHeight: contentScrollHeight,
    scrollTop: Math.min(maxScrollTop, Math.max(0, scrollTop)),
    maxScrollTop,
  };
}

/**
 * Limit native scrolling while the live-tail spacer is mounted. A pinned
 * position may temporarily keep the latest user message near the top, but the
 * spacer itself must never create additional user-scrollable blank space.
 */
export function getLiveTailScrollLimit({
  scrollHeight,
  scrollTop,
  clientHeight,
  transientTailHeight = 0,
  pinnedScrollTop = null,
}: LiveTailScrollLimitInput): number {
  const metrics = getContentScrollMetrics({
    scrollHeight,
    scrollTop,
    clientHeight,
    transientTailHeight,
  });
  const nativeMaxScrollTop = Math.max(0, scrollHeight - Math.max(0, clientHeight));
  const preservedPinnedTop = pinnedScrollTop === null
    ? 0
    : Math.max(0, pinnedScrollTop);
  return Math.min(nativeMaxScrollTop, Math.max(metrics.maxScrollTop, preservedPinnedTop));
}

/** Consume viewport wheel input before the compositor enters the invisible tail.
 * Correcting scrollTop in a later scroll event produces visible bounce on Windows.
 */
export function scrollLiveTailWheel(container: HTMLElement, event: WheelEvent, pinnedScrollTop: number | null): boolean {
  if (event.ctrlKey || !event.cancelable || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  const spacer = container.querySelector<HTMLElement>("[data-chat-tail-spacer]");
  if (!spacer) return false;
  // Code blocks and terminal panes retain their own native scrolling.
  let child = event.target instanceof Element ? event.target : null;
  while (child && child !== container) {
    const style = getComputedStyle(child);
    if (/(auto|scroll)/.test(style.overflowY) && child.scrollHeight > child.clientHeight + 1) {
      if (event.deltaY < 0 ? child.scrollTop > 0 : child.scrollTop + child.clientHeight < child.scrollHeight - 1) return false;
      if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false;
    }
    child = child.parentElement;
  }
  const max = getLiveTailScrollLimit({ scrollHeight: container.scrollHeight, scrollTop: container.scrollTop, clientHeight: container.clientHeight, transientTailHeight: spacer.offsetHeight, pinnedScrollTop });
  const unit = event.deltaMode === 2 ? container.clientHeight : event.deltaMode === 1 ? 16 : 1;
  const top = Math.max(0, Math.min(max, container.scrollTop + event.deltaY * unit));
  event.preventDefault();
  if (Math.abs(top - container.scrollTop) > 0.01) container.scrollTo({ top, behavior: "instant" });
  return true;
}

/**
 * The live chat adds a viewport-sized tail spacer so the latest user message
 * can be positioned near the top while an agent is working. That spacer is a
 * scrolling aid, not message content, and must not make the jump-to-bottom
 * control appear before the conversation itself fills the viewport.
 */
export function shouldShowScrollToBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
  transientTailHeight = 0,
  threshold,
}: ScrollToBottomVisibilityInput): boolean {
  const metrics = getContentScrollMetrics({
    scrollHeight,
    scrollTop,
    clientHeight,
    transientTailHeight,
  });
  const contentHeight = metrics.scrollHeight;
  const contentOverflowsViewport = contentHeight > clientHeight + 1;
  // Measure against the real content height, not scrollHeight, so the tail
  // spacer cannot keep the button visible after the user already reached the
  // bottom of the conversation.
  const distanceFromBottom = contentHeight - metrics.scrollTop - clientHeight;
  return contentOverflowsViewport && distanceFromBottom > threshold;
}
