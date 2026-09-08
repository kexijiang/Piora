"use client";

import { Fragment, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { buildVirtualOffsets, virtualIndexAt, virtualRange } from "@/lib/virtual-window";
import { createVirtualRowState } from "@/lib/virtual-row-state";
import { isChatBottomFollowing } from "@/lib/chat-bottom-follow";
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

  const listTop = useCallback(() => {
    if (!root.current || !parent.current) return 0;
    return root.current.getBoundingClientRect().top - parent.current.getBoundingClientRect().top + parent.current.scrollTop - parent.current.clientTop;
  }, []);
  const syncRange = useCallback(() => {
    const scroller = parent.current;
    if (!scroller || scroller.clientHeight === 0 || scroller.getClientRects().length === 0) return;
    // During a bottom jump the DOM height and cached offsets temporarily differ.
    // Keep the tail mounted until its lazy content is measured; otherwise a
    // scroll correction can unmount it, reset its height, and repeat forever.
    const top = isChatBottomFollowing(scroller)
      ? Math.max(0, (current.current.offsets.at(-1) ?? 0) - scroller.clientHeight)
      : scroller.scrollTop - listTop();
    const next = virtualRange(current.current.offsets, top, scroller.clientHeight);
    setRange((previous) => previous.start === next.start && previous.end === next.end ? previous : next);
  }, [listTop]);
  const scrollToKey = useCallback((key: string) => {
    const index = current.current.keys.indexOf(key);
    if (index < 0 || !parent.current) return;
    navigation.current = { key };
    setNavigationKey(key);
    anchor.current = null;
    parent.current.scrollTop = Math.max(0, listTop() + current.current.offsets[index] - parent.current.clientHeight * 0.3);
    syncRange();
  }, [listTop, syncRange]);
  const cancelNavigation = useCallback(() => { navigation.current = null; anchor.current = null; setNavigationKey(null); }, []);
  useImperativeHandle(handleRef, () => ({ scrollToKey, cancelNavigation }), [scrollToKey, cancelNavigation]);

  const measure = useCallback((key: string, height: number) => {
    height = Math.max(1, height);
    if (Math.abs((heights.current.get(key) ?? estimate) - height) < 1) return;
    if (!anchor.current && parent.current && !navigation.current && !isChatBottomFollowing(parent.current)) {
      const top = parent.current.scrollTop - listTop();
      const index = virtualIndexAt(current.current.offsets, top);
      if (current.current.keys[index]) anchor.current = { key: current.current.keys[index], inset: top - current.current.offsets[index] };
    }
    heights.current.set(key, height);
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setMeasurementVersion((version) => version + 1);
    });
  }, [estimate, listTop]);

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
    const onScroll = () => { syncRange(); };
    const onInput = cancelNavigation;
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onInput, { passive: true });
    element.addEventListener("touchstart", onInput, { passive: true });
    document.addEventListener("pointerdown", onInput, { capture: true, passive: true });
    document.addEventListener("keydown", onInput);
    const observer = new ResizeObserver(() => {
      const width = root.current?.getBoundingClientRect().width ?? 0;
      if (width > 0 && measuredWidth.current > 0 && Math.abs(width - measuredWidth.current) > 1) {
        const top = element.scrollTop - listTop();
        const index = virtualIndexAt(current.current.offsets, top);
        if (!navigation.current && !isChatBottomFollowing(element) && current.current.keys[index]) anchor.current = { key: current.current.keys[index], inset: top - current.current.offsets[index] };
        // Wrapping changes invalidate offscreen heights as well as mounted ones.
        heights.current.clear();
        root.current?.querySelectorAll<HTMLElement>("[data-virtual-key]").forEach((row) => {
          const height = row.getBoundingClientRect().height;
          if (height > 0 && row.dataset.virtualKey) heights.current.set(row.dataset.virtualKey, height);
        });
        setMeasurementVersion((version) => version + 1);
      }
      if (width > 0) measuredWidth.current = width;
      syncRange();
    });
    observer.observe(element);
    if (root.current) observer.observe(root.current);
    syncRange();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onInput);
      element.removeEventListener("touchstart", onInput);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput);
    };
  }, [scrollContainer, syncRange, cancelNavigation, listTop]);

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
    } else if (anchor.current && !isChatBottomFollowing(scroller)) {
      const index = keys.indexOf(anchor.current.key);
      if (index >= 0) scroller.scrollTop = Math.max(0, listTop() + offsets[index] + anchor.current.inset);
    }
    anchor.current = null;
    syncRange();
  }, [keys, offsets, navigationKey, listTop, syncRange, initialTail]);

  useEffect(() => {
    const retained = new Set(keys);
    for (const key of heights.current.keys()) if (!retained.has(key)) heights.current.delete(key);
    for (const key of rowStates.current.keys()) if (!retained.has(key)) rowStates.current.delete(key);
  }, [keys]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
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
