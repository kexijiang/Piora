"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_RUN_STATUS_PHRASE_PREFERENCE,
  parseStoredRunStatusPhrasePreference,
  RUN_STATUS_PHRASE_STORAGE_KEY,
  serializeRunStatusPhrasePreference,
  type RunStatusPhrasePreference,
} from "@/lib/run-status-phrase-settings";
import type { RunStatusPhraseStyle } from "@/lib/run-status-phrase-prompts";

const listeners = new Set<() => void>();
let currentPreference: RunStatusPhrasePreference = { ...DEFAULT_RUN_STATUS_PHRASE_PREFERENCE };
let storageListenerAttached = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function commitPreference(preference: RunStatusPhrasePreference, persist: boolean): void {
  currentPreference = parseStoredRunStatusPhrasePreference(serializeRunStatusPhrasePreference(preference));
  if (persist) {
    try {
      window.localStorage.setItem(RUN_STATUS_PHRASE_STORAGE_KEY, serializeRunStatusPhrasePreference(currentPreference));
    } catch {
      // Keep the preference active for this renderer when storage is unavailable.
    }
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== RUN_STATUS_PHRASE_STORAGE_KEY) return;
      commitPreference(parseStoredRunStatusPhrasePreference(event.newValue), false);
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot(): RunStatusPhrasePreference {
  return currentPreference;
}

function getServerSnapshot(): RunStatusPhrasePreference {
  return DEFAULT_RUN_STATUS_PHRASE_PREFERENCE;
}

export function useRunStatusPhrasePreference() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    let stored = { ...DEFAULT_RUN_STATUS_PHRASE_PREFERENCE };
    try {
      stored = parseStoredRunStatusPhrasePreference(
        window.localStorage.getItem(RUN_STATUS_PHRASE_STORAGE_KEY),
      );
    } catch {
      // Keep the default when storage is unavailable.
    }
    commitPreference(stored, false);
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    commitPreference({ ...currentPreference, enabled }, true);
  }, []);

  const setStyle = useCallback((style: RunStatusPhraseStyle) => {
    commitPreference({ ...currentPreference, style }, true);
  }, []);

  const setCustomPrompt = useCallback((customPrompt: string) => {
    commitPreference({ ...currentPreference, customPrompt }, true);
  }, []);

  return { preference, setEnabled, setStyle, setCustomPrompt };
}
