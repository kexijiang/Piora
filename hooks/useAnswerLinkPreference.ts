"use client";

import { useSyncExternalStore } from "react";
import { ANSWER_LINK_TARGET_STORAGE_KEY, parseAnswerLinkTarget, type AnswerLinkTarget } from "@/lib/answer-links";

const listeners = new Set<() => void>();
let fallback: AnswerLinkTarget = "builtin";
let memoryOverride = false;
const emit = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === null || event.key === ANSWER_LINK_TARGET_STORAGE_KEY) { memoryOverride = false; listener(); }
  };
  window.addEventListener("storage", changed);
  return () => { listeners.delete(listener); window.removeEventListener("storage", changed); };
}

function snapshot(): AnswerLinkTarget {
  if (memoryOverride) return fallback;
  try { return parseAnswerLinkTarget(window.localStorage.getItem(ANSWER_LINK_TARGET_STORAGE_KEY)); }
  catch { return fallback; }
}

function setTarget(target: AnswerLinkTarget) {
  fallback = target;
  try { window.localStorage.setItem(ANSWER_LINK_TARGET_STORAGE_KEY, target); memoryOverride = false; }
  catch { memoryOverride = true; /* Keep the preference active for this renderer. */ }
  emit();
}

export function useAnswerLinkPreference() {
  const target = useSyncExternalStore(subscribe, snapshot, () => "builtin" as const);
  return { target, setTarget };
}
