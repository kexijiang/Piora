"use client";
import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { clipboardMessage } from "@/desktop/src/clipboard-messages";

export function useClipboardI18n() {
  const { locale } = useI18n();
  const tr = useCallback((message: string, params?: Record<string, string | number>) => clipboardMessage(locale === "en" ? "en" : "zh-CN", message, params), [locale]);
  return { locale, tr };
}
