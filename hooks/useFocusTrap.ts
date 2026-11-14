"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute("disabled")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest("[inert]")) return false;
    return true;
  });
}

/**
 * Keeps keyboard focus inside an active floating layer and restores focus to
 * the element that opened it. Focusable descendants are queried on every Tab
 * press so async and conditionally-rendered controls participate immediately.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts?: {
    initialFocus?: RefObject<HTMLElement | null>;
    onEscape?: () => void;
  },
): void {
  const initialFocus = opts?.initialFocus;
  const onEscapeRef = useRef(opts?.onEscape);
  onEscapeRef.current = opts?.onEscape;

  useEffect(() => {
    if (!active) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const container = ref.current;
    if (!container) return;

    const previousTabIndex = container.getAttribute("tabindex");
    if (previousTabIndex === null) container.tabIndex = -1;

    const focusFrame = window.requestAnimationFrame(() => {
      // Keep a keyboard or pointer selection made before the first frame.
      if (container.contains(document.activeElement)) return;
      const target = initialFocus?.current ?? getFocusableElements(container)[0] ?? container;
      target.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      // A themed native picker owns Escape before its surrounding dialog.
      if (event.key === "Escape" && event.target instanceof Element
        && event.target.closest("select")?.matches(":open")) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      const focusIsInside = current instanceof Node && container.contains(current);

      if (event.shiftKey && (!focusIsInside || current === first)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (!focusIsInside || current === last)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (previousTabIndex === null) container.removeAttribute("tabindex");
      else container.setAttribute("tabindex", previousTabIndex);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [active, initialFocus, ref]);
}
