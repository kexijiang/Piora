"use client";

import { Fragment, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { flushSync } from "react-dom";
import { buildVirtualOffsets, virtualIndexAt, virtualRange } from "@/lib/virtual-window";
import { createVirtualRowState } from "@/lib/virtual-row-state";
import { CHAT_BOTTOM_FOLLOW_EVENT, isChatBottomFollowing, pinChatBottom } from "@/lib/chat-bottom-follow";
import { VirtualRowStateContext } from "./VirtualRowState";

export interface VirtualListHandle { scrollToKey(key: string): void; cancelNavigation(): void }
interface Props {
  keys: readonly string[];
  renderItem: (key: string, index: number) => ReactNode;
  estimate: number;
  scrollContainer?: RefObject<HTMLElement | null>;
  handleRef?: Ref<VirtualListHandle>;
  initialTail?: boolean;
  pinnedKeys?: readonly string[];
}

const MeasuredRow = memo(function MeasuredRow({ rowKey, measure, children }: { rowKey: string; measure: (key: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      // Settings can hide the chat. Hidden rows have no valid measurement.
      if (rect.width > 0 && rect.height > 0) measure(rowKey, rect.height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [rowKey, measure]);
  return <div ref={ref} data-virtual-key={rowKey} style={{ display: "flow-root", overflowAnchor: "none" }}>{children}</div>;
});

/** Variable-height windowing with retained measurements and a stable scroll anchor. */
export function VirtualList({ keys, renderItem, estimate, scrollContainer, handleRef, initialTail = false, pinnedKeys = [] }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const parent = useRef<HTMLElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const rowStates = useRef(new Map<string, ReturnType<typeof createVirtualRowState>>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const offsets = useMemo(() => {
    // ResizeObserver writes to the measurement map; this version publishes a batch.
    void measurementVersion;
    return buildVirtualOffsets(keys, heights.current, estimate);
  }, [keys, estimate, measurementVersion]);
  const current = useRef({ keys, offsets });
  current.current = { keys, offsets };
  const [range, setRange] = useState(() => ({ start: initialTail ? Math.max(0, keys.length - 30) : 0, end: initialTail ? keys.length : Math.min(30, keys.length) }));
  const anchor = useRef<{ key: string; inset: number } | null>(null);
  const navigation = useRef<{ key: string } | null>(null);
  const [navigationKey, setNavigationKey] = useState<string | null>(null);
  const initialized = useRef(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const frame = useRef<number | null>(null);
  const measuredWidth = useRef(0);
  const viewportSnapshot = useRef({ width: 0, height: 0, atBottom: false });
  // Shared by viewport resizes and manual wheel navigation to the bottom.
  const resizeBottomAnchor = useRef(false);
  const resizeSettleFrame = useRef<number | null>(null);

  const rememberViewport = useCallback(() => {
    const scroller = parent.current;
    if (!scroller || !root.current) return;
    viewportSnapshot.current = { width: root.current.getBoundingClientRect().width, height: scroller.clientHeight,
      atBottom: resizeBottomAnchor.current || Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 2 };
  }, []);

  const settleBottomResize = useCallback(() => {
    if (resizeSettleFrame.current !== null) return;
    let previous = "", stableFrames = 0;
    const settle = () => {
      resizeSettleFrame.current = null;
      const scroller = parent.current;
      if (!resizeBottomAnchor.current || !scroller || !root.current) return;
      if (navigation.current || isChatBottomFollowing(scroller) || scroller.querySelector("[data-chat-tail-spacer]")) { resizeBottomAnchor.current = false; rememberViewport(); return; }
      // Keep the tail anchored for the whole width transition and its queued
      // row measurements, rather than releasing after the first React commit.
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const geometry = `${root.current.getBoundingClientRect().width}:${scroller.clientHeight}:${scroller.scrollHeight}`;
      stableFrames = geometry === previous && frame.current === null ? stableFrames + 1 : 0;
      previous = geometry;
      if (stableFrames >= 3) { resizeBottomAnchor.current = false; rememberViewport(); }
      else resizeSettleFrame.current = requestAnimationFrame(settle);
    };
    resizeSettleFrame.current = requestAnimationFrame(settle);
  }, [rememberViewport]);

  const listTop = useCallback(() => {
    if (!root.current || !parent.current) return 0;
    return root.current.getBoundingClientRect().top - parent.current.getBoundingClientRect().top + parent.current.scrollTop - parent.current.clientTop;
  }, []);
  const syncRange = useCallback(() => {
    const scroller = parent.current;
    if (!scroller || scroller.clientHeight === 0 || scroller.getClientRects().length === 0) return;
    // Mounted rows have already changed the DOM height, but their offsets are
    // published in the next measurement commit. A scroll/clamp in this gap
    // must not recycle rows using the old offsets: remounting deferred content
    // resets its height and can restart the same scroll/measurement cycle.
    // The measurement layout effect below restores the anchor and retries.
    if (frame.current !== null) return;
    // During a bottom jump the DOM height and cached offsets temporarily differ.
    // Keep the tail mounted until its lazy content is measured; otherwise a
    // scroll correction can unmount it, reset its height, and repeat forever.
    const top = isChatBottomFollowing(scroller) || resizeBottomAnchor.current
      ? Math.max(0, (current.current.offsets.at(-1) ?? 0) - scroller.clientHeight)
      : scroller.scrollTop - listTop();
    const next = virtualRange(current.current.offsets, top, scroller.clientHeight);
    setRange((previous) => previous.start === next.start && previous.end === next.end ? previous : next);
  }, [listTop]);
  const scrollToKey = useCallback((key: string) => {
    const index = current.current.keys.indexOf(key);
    if (index < 0 || !parent.current) return;
    navigation.current = { key };
    resizeBottomAnchor.current = false;
    setNavigationKey(key);
    anchor.current = null;
    parent.current.scrollTop = Math.max(0, listTop() + current.current.offsets[index] - parent.current.clientHeight * 0.3);
    syncRange();
  }, [listTop, syncRange]);
  const cancelNavigation = useCallback(() => { navigation.current = null; anchor.current = null; resizeBottomAnchor.current = false; setNavigationKey(null); }, []);
  useImperativeHandle(handleRef, () => ({ scrollToKey, cancelNavigation }), [scrollToKey, cancelNavigation]);

  const measure = useCallback((key: string, height: number) => {
    height = Math.max(1, height);
    if (Math.abs((heights.current.get(key) ?? estimate) - height) < 1) return;
    const scroller = parent.current;
    // Shrinking content can clamp native scrolling before ResizeObserver is
    // delivered. Preserve an already-visible bottom instead of interpreting
    // that clamp as navigation into older messages using the previous offsets.
    if (scroller && viewportSnapshot.current.atBottom && !navigation.current && !isChatBottomFollowing(scroller)
      && !scroller.querySelector("[data-chat-tail-spacer]")) {
      resizeBottomAnchor.current = true;
      anchor.current = null;
      settleBottomResize();
    }
    if (!anchor.current && !resizeBottomAnchor.current && parent.current && !navigation.current && !isChatBottomFollowing(parent.current)) {
      const top = parent.current.scrollTop - listTop();
      const index = virtualIndexAt(current.current.offsets, top);
      if (current.current.keys[index]) anchor.current = { key: current.current.keys[index], inset: top - current.current.offsets[index] };
    }
    heights.current.set(key, height);
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      // Publish offsets and restore the reading anchor in this frame before
      // another scroll event can consume the old geometry.
      flushSync(() => setMeasurementVersion((version) => version + 1));
    });
  }, [estimate, listTop, settleBottomResize]);

  const measureChangedLayout = useCallback(() => {
    const element = root.current;
    if (!element || Math.abs(element.getBoundingClientRect().height - (current.current.offsets.at(-1) ?? 0)) < 1) return;
    // Scroll events may precede the row observers. Detect that gap before
    // choosing a window, not only after the observers queue their update.
    element.querySelectorAll<HTMLElement>(":scope > [data-virtual-key]").forEach((row) => {
      const rect = row.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && row.dataset.virtualKey) measure(row.dataset.virtualKey, rect.height);
    });
  }, [measure]);

  useLayoutEffect(() => {
    let element = scrollContainer?.current ?? root.current?.parentElement ?? null;
    // Child layout effects can run before the ancestor's ref is attached.
    // Resolve the real scrolling ancestor in that case; the immediate content
    // wrapper grows with the list and would make the window include every row.
    if (!scrollContainer?.current) {
      while (element && !/(auto|scroll)/.test(getComputedStyle(element).overflowY)) element = element.parentElement;
    }
    parent.current = element;
    if (!element) return;
    const onScroll = () => {
      // Reaching the bottom with the wheel needs the same stable tail window
      // as an explicit jump. Keep it through row recycling and deferred sizes;
      // otherwise the native clamp can look like a request for older rows.
      if (!navigation.current && !isChatBottomFollowing(element)
        && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2
        && !element.querySelector("[data-chat-tail-spacer]")) {
        resizeBottomAnchor.current = true;
        anchor.current = null;
        settleBottomResize();
      }
      measureChangedLayout();
      // A browser scroll clamp may arrive before ResizeObserver. Keep the last
      // pre-resize position until the new geometry has been anchored.
      if (!resizeBottomAnchor.current && Math.abs((root.current?.getBoundingClientRect().width ?? 0) - viewportSnapshot.current.width) <= 1
        && element.clientHeight === viewportSnapshot.current.height) rememberViewport();
      syncRange();
    };
    const onInput = (event: Event) => {
      cancelNavigation();
      if (event.type === "wheel" || event.type === "touchstart") viewportSnapshot.current.atBottom = false;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener(CHAT_BOTTOM_FOLLOW_EVENT, syncRange);
    element.addEventListener("wheel", onInput, { passive: true });
    element.addEventListener("touchstart", onInput, { passive: true });
    document.addEventListener("pointerdown", onInput, { capture: true, passive: true });
    document.addEventListener("keydown", onInput);
    const observer = new ResizeObserver(() => {
      measureChangedLayout();
      const width = root.current?.getBoundingClientRect().width ?? 0;
      const viewportChanged = width > 0 && viewportSnapshot.current.width > 0
        && (Math.abs(width - viewportSnapshot.current.width) > 1 || element.clientHeight !== viewportSnapshot.current.height);
      if (viewportChanged && viewportSnapshot.current.atBottom && !navigation.current && !isChatBottomFollowing(element)) {
        resizeBottomAnchor.current = true;
        anchor.current = null;
        settleBottomResize();
        setMeasurementVersion((version) => version + 1);
      }
      if (width > 0 && measuredWidth.current > 0 && Math.abs(width - measuredWidth.current) > 1) {
        const top = element.scrollTop - listTop();
        const index = virtualIndexAt(current.current.offsets, top);
        if (!resizeBottomAnchor.current && !navigation.current && !isChatBottomFollowing(element) && current.current.keys[index]) anchor.current = { key: current.current.keys[index], inset: top - current.current.offsets[index] };
        // Wrapping changes invalidate offscreen heights as well as mounted ones.
        heights.current.clear();
        root.current?.querySelectorAll<HTMLElement>("[data-virtual-key]").forEach((row) => {
          const height = row.getBoundingClientRect().height;
          if (height > 0 && row.dataset.virtualKey) heights.current.set(row.dataset.virtualKey, height);
        });
        setMeasurementVersion((version) => version + 1);
      }
      if (width > 0) measuredWidth.current = width;
      if (!resizeBottomAnchor.current) rememberViewport();
      syncRange();
    });
    observer.observe(element);
    if (root.current) observer.observe(root.current);
    syncRange();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener(CHAT_BOTTOM_FOLLOW_EVENT, syncRange);
      element.removeEventListener("wheel", onInput);
      element.removeEventListener("touchstart", onInput);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput);
    };
  }, [scrollContainer, syncRange, cancelNavigation, listTop, rememberViewport, settleBottomResize, measureChangedLayout]);

  useLayoutEffect(() => {
    const scroller = parent.current;
    if (!scroller) return;
    if (!initialized.current && keys.length) {
      initialized.current = true;
      if (initialTail) scroller.scrollTop = listTop() + offsets[offsets.length - 1];
    }
    if (navigation.current) {
      const index = keys.indexOf(navigation.current.key);
      // Mount first, then align against actual layout. Estimated offsets alone
      // are stale during the first commit and while images/markdown settle.
      const target = Array.from(root.current?.querySelectorAll<HTMLElement>(":scope > [data-virtual-key]") ?? [])
        .find((row) => row.dataset.virtualKey === navigation.current?.key);
      if (index >= 0) {
        const top = target
          ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop
          : listTop() + offsets[index];
        scroller.scrollTop = Math.max(0, top - scroller.clientHeight * 0.3);
      }
    } else if (resizeBottomAnchor.current && !isChatBottomFollowing(scroller)) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    } else if (anchor.current && !isChatBottomFollowing(scroller)) {
      const index = keys.indexOf(anchor.current.key);
      if (index >= 0) scroller.scrollTop = Math.max(0, listTop() + offsets[index] + anchor.current.inset);
    }
    anchor.current = null;
    rememberViewport();
    syncRange();
  }, [keys, offsets, navigationKey, listTop, syncRange, initialTail, rememberViewport]);

  // Range-only commits also replace spacers with measured content. Keep the
  // requested bottom aligned in the same commit, before the browser paints.
  useLayoutEffect(() => {
    const scroller = parent.current;
    if (!scroller) return;
    if (resizeBottomAnchor.current && !isChatBottomFollowing(scroller)) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    } else pinChatBottom(scroller);
  });

  useEffect(() => {
    const retained = new Set(keys);
    for (const key of heights.current.keys()) if (!retained.has(key)) heights.current.delete(key);
    for (const key of rowStates.current.keys()) if (!retained.has(key)) rowStates.current.delete(key);
  }, [keys]);
  useEffect(() => {
    // Strict Mode can cancel the initial measurement frame and replay effects
    // with the populated map. Publish it even if the row sizes did not change.
    if (frame.current === null && heights.current.size) setMeasurementVersion((version) => version + 1);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (resizeSettleFrame.current !== null) cancelAnimationFrame(resizeSettleFrame.current);
      frame.current = null;
      resizeSettleFrame.current = null;
    };
  }, []);
  const start = Math.min(range.start, keys.length);
  const end = Math.min(Math.max(start, range.end), keys.length);
  const mounted = new Set(Array.from({ length: end - start }, (_, index) => start + index));
  for (const key of [...pinnedKeys, ...(focusedKey ? [focusedKey] : []), ...(navigationKey ? [navigationKey] : [])]) {
    const index = keys.indexOf(key); if (index >= 0) mounted.add(index);
  }
  const indices = [...mounted].sort((a, b) => a - b);
  return <div ref={root} data-virtual-list="" data-virtual-total={keys.length} style={{ overflowAnchor: "none" }}
    onFocusCapture={(event) => setFocusedKey((event.target as HTMLElement).closest<HTMLElement>("[data-virtual-key]")?.dataset.virtualKey ?? null)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null); }}>
    {indices.map((index, position) => {
      const key = keys[index];
      let rowState = rowStates.current.get(key);
      if (!rowState) { rowState = createVirtualRowState(); rowStates.current.set(key, rowState); }
      return <Fragment key={key}>
      <div aria-hidden="true" style={{ height: Math.max(0, offsets[index] - offsets[position ? indices[position - 1] + 1 : 0]) }} />
      <MeasuredRow rowKey={key} measure={measure}><VirtualRowStateContext.Provider value={rowState}>{renderItem(key, index)}</VirtualRowStateContext.Provider></MeasuredRow>
    </Fragment>;
    })}
    <div aria-hidden="true" style={{ height: Math.max(0, (offsets.at(-1) ?? 0) - offsets[indices.length ? indices[indices.length - 1] + 1 : 0]) }} />
  </div>;
}
