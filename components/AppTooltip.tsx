"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const TOOLTIP_ID = "pi-app-tooltip";
const POINTER_DELAY_MS = 360;
const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 7;

type ActivationReason = "pointer" | "focus";
type TooltipPlacement = "top" | "bottom";

interface ActiveTarget {
  element: Element;
  title: string;
  pointer: boolean;
  focus: boolean;
  previousDescribedBy: string | null;
  addedAriaLabel: boolean;
}

interface TooltipContent {
  element: Element;
  text: string;
  anchor: DOMRect;
}

interface TooltipPosition {
  left: number;
  top: number;
  arrowX: number;
  placement: TooltipPlacement;
}

type TooltipCssProperties = CSSProperties & {
  "--app-tooltip-arrow-x": string;
};

function findTitleTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  // iframe titles are accessibility names, not hover hints.
  return target.closest("[title]:not(iframe)");
}

function hasVisibleLabel(element: Element): boolean {
  return Boolean(element.textContent?.trim());
}

function isInteractive(element: Element): boolean {
  return element.matches("button, a[href], input, select, textarea, [role='button'], [role='menuitem'], [tabindex]");
}

function isHydrationReady(element: Element): boolean {
  const appShell = element.closest(".app-shell");
  return !appShell || appShell.hasAttribute("data-app-hydrated");
}

/**
 * Replaces browser-native title bubbles with one theme-aware tooltip layer.
 * Event delegation means existing and newly rendered title attributes are
 * covered without each component needing its own tooltip implementation.
 */
export function AppTooltip() {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveTarget | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const [content, setContent] = useState<TooltipContent | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useEffect(() => {
    const clearShowTimer = () => {
      if (showTimerRef.current === null) return;
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    };

    const restoreTarget = (active: ActiveTarget) => {
      const { element } = active;
      if (!element.isConnected) return;

      if (!element.hasAttribute("title")) {
        element.setAttribute("title", active.title);
      }

      if (active.previousDescribedBy === null) {
        element.removeAttribute("aria-describedby");
      } else {
        element.setAttribute("aria-describedby", active.previousDescribedBy);
      }

      if (active.addedAriaLabel && element.getAttribute("aria-label") === active.title) {
        element.removeAttribute("aria-label");
      }
    };

    const hide = (restore = true) => {
      clearShowTimer();
      const active = activeRef.current;
      activeRef.current = null;
      if (active && restore) restoreTarget(active);
      setContent(null);
      setPosition(null);
    };

    const reveal = (active: ActiveTarget, delay: number) => {
      clearShowTimer();
      const show = () => {
        showTimerRef.current = null;
        if (activeRef.current !== active || (!active.pointer && !active.focus) || !active.element.isConnected) return;
        setContent({
          element: active.element,
          text: active.title,
          anchor: active.element.getBoundingClientRect(),
        });
      };
      if (delay === 0) show();
      else showTimerRef.current = window.setTimeout(show, delay);
    };

    const activate = (element: Element, reason: ActivationReason) => {
      // AppTooltip lives outside the page Suspense boundary and may hydrate
      // before AppShell. Do not rewrite SSR attributes while React is still
      // matching that subtree; a stationary pointer can otherwise turn a
      // title into aria-describedby before its button hydrates.
      if (!isHydrationReady(element)) return;
      const current = activeRef.current;
      if (current?.element === element) {
        current[reason] = true;
        if (reason === "focus") reveal(current, 0);
        return;
      }

      if (current) hide();
      const rawTitle = element.getAttribute("title");
      const title = rawTitle?.trim();
      if (!title) return;

      const previousDescribedBy = element.getAttribute("aria-describedby");
      const describedByTokens = previousDescribedBy?.split(/\s+/).filter(Boolean) ?? [];
      if (!describedByTokens.includes(TOOLTIP_ID)) {
        element.setAttribute("aria-describedby", [...describedByTokens, TOOLTIP_ID].join(" "));
      }

      const addedAriaLabel = isInteractive(element)
        && !element.hasAttribute("aria-label")
        && !hasVisibleLabel(element);
      if (addedAriaLabel) element.setAttribute("aria-label", title);

      element.removeAttribute("title");
      const active: ActiveTarget = {
        element,
        title: rawTitle!,
        pointer: reason === "pointer",
        focus: reason === "focus",
        previousDescribedBy,
        addedAriaLabel,
      };
      activeRef.current = active;
      reveal(active, reason === "focus" ? 0 : POINTER_DELAY_MS);
    };

    const deactivate = (reason: ActivationReason) => {
      const active = activeRef.current;
      if (!active) return;
      active[reason] = false;
      if (!active.pointer && !active.focus) hide();
    };

    const onPointerOver = (event: PointerEvent) => {
      const active = activeRef.current;
      if (active && event.target instanceof Node && active.element.contains(event.target)) {
        active.pointer = true;
        return;
      }
      const target = findTitleTarget(event.target);
      if (target) activate(target, "pointer");
    };

    const onPointerOut = (event: PointerEvent) => {
      const active = activeRef.current;
      if (!active || !(event.target instanceof Node) || !active.element.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && active.element.contains(event.relatedTarget)) return;
      deactivate("pointer");
    };

    const onFocusIn = (event: FocusEvent) => {
      const active = activeRef.current;
      if (active && event.target instanceof Node && active.element.contains(event.target)) {
        active.focus = true;
        reveal(active, 0);
        return;
      }
      const target = findTitleTarget(event.target);
      if (target) activate(target, "focus");
    };

    const onFocusOut = (event: FocusEvent) => {
      const active = activeRef.current;
      if (!active || !(event.target instanceof Node) || !active.element.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && active.element.contains(event.relatedTarget)) return;
      deactivate("focus");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    const hideVisibleTooltip = () => {
      clearShowTimer();
      setContent(null);
      setPosition(null);
    };
    const onWindowBlur = () => hide();

    let frame = 0;
    const refreshAnchor = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const active = activeRef.current;
        if (!active?.element.isConnected) {
          if (active) hide(false);
          return;
        }
        setContent((previous) => previous && previous.element === active.element
          ? { ...previous, anchor: active.element.getBoundingClientRect() }
          : previous);
      });
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", hideVisibleTooltip, true);
    document.addEventListener("scroll", refreshAnchor, true);
    window.addEventListener("resize", refreshAnchor);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", hideVisibleTooltip, true);
      document.removeEventListener("scroll", refreshAnchor, true);
      window.removeEventListener("resize", refreshAnchor);
      window.removeEventListener("blur", onWindowBlur);
      if (frame) window.cancelAnimationFrame(frame);
      clearShowTimer();
      const active = activeRef.current;
      activeRef.current = null;
      if (active) restoreTarget(active);
    };
  }, []);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!content || !tooltip) {
      setPosition(null);
      return;
    }

    const bounds = tooltip.getBoundingClientRect();
    const anchorCenter = content.anchor.left + content.anchor.width / 2;
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - bounds.width - VIEWPORT_GAP);
    const left = Math.min(Math.max(anchorCenter - bounds.width / 2, VIEWPORT_GAP), maxLeft);
    const roomAbove = content.anchor.top - VIEWPORT_GAP;
    const roomBelow = window.innerHeight - content.anchor.bottom - VIEWPORT_GAP;
    const placement: TooltipPlacement = roomAbove >= bounds.height + ANCHOR_GAP || roomAbove >= roomBelow
      ? "top"
      : "bottom";
    const preferredTop = placement === "top"
      ? content.anchor.top - bounds.height - ANCHOR_GAP
      : content.anchor.bottom + ANCHOR_GAP;
    const maxTop = Math.max(VIEWPORT_GAP, window.innerHeight - bounds.height - VIEWPORT_GAP);
    const top = Math.min(Math.max(preferredTop, VIEWPORT_GAP), maxTop);
    const arrowX = Math.min(Math.max(anchorCenter - left, 8), Math.max(8, bounds.width - 8));

    setPosition({ left, top, arrowX, placement });
  }, [content]);

  const style: TooltipCssProperties = {
    // Keep the tooltip out of body's column flex layout from the very first
    // paint. During a packaged-app cold start the stylesheet can arrive after
    // this markup; relying on `.app-tooltip { position: fixed }` alone lets a
    // hovered title briefly become a flex item and shrink the application.
    position: "fixed",
    zIndex: 1600,
    pointerEvents: "none",
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    "--app-tooltip-arrow-x": `${position?.arrowX ?? 12}px`,
  };

  return (
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      role="tooltip"
      className={`app-tooltip app-tooltip-${position?.placement ?? "top"}${position ? " is-visible" : ""}`}
      style={style}
    >
      {content?.text ?? ""}
    </div>
  );
}
