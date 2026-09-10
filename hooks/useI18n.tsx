"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, LocalePlugin, TranslationParams } from "@/lib/i18n/types";
import { zhCNLocale } from "@/lib/i18n/messages/zh-CN";

const LOCALE_STORAGE_KEY = "pi-locale";
const defaultLocale: Locale = "zh-CN";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: Array<Pick<LocalePlugin, "id" | "label">>;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const supportedLocales: I18nContextValue["supportedLocales"] = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
];
let englishLocalePromise: Promise<LocalePlugin> | null = null;

function loadEnglishLocale(): Promise<LocalePlugin> {
  if (!englishLocalePromise) {
    const pending = import("@/lib/i18n/messages/en").then((module) => module.enLocale);
    englishLocalePromise = pending;
    void pending.catch(() => {
      if (englishLocalePromise === pending) englishLocalePromise = null;
    });
  }
  return englishLocalePromise;
}

function resolveBrowserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  }
  return "en";
}

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    // 隐私模式或存储不可用时继续使用浏览器语言。
  }
  return resolveBrowserLocale(window.navigator.languages.length ? window.navigator.languages : [window.navigator.language]);
}

/**
 * 提供 Pi Web 的界面语言状态和翻译能力。
 * @param props React 子节点
 * @returns 包含语言上下文的 React 节点
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<Record<string, Record<string, string>>>(() => ({
    "zh-CN": zhCNLocale.messages,
  }));
  const localeRequestRef = useRef(0);

  useEffect(() => {
    const next = readInitialLocale();
    const requestId = ++localeRequestRef.current;
    let cancelled = false;
    const hydrateLocale = async () => {
      try {
        if (next === "en") {
          const plugin = await loadEnglishLocale();
          if (cancelled || localeRequestRef.current !== requestId) return;
          setMessages((current) => current.en ? current : { ...current, en: plugin.messages });
        }
      } catch {
        if (!cancelled && localeRequestRef.current === requestId) {
          document.documentElement.lang = defaultLocale;
          setHydrated(true);
        }
        return;
      }
      if (cancelled || localeRequestRef.current !== requestId) return;
      setLocaleState(next);
      document.documentElement.lang = next;
      setHydrated(true);
    };
    void hydrateLocale();
    return () => { cancelled = true; };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (next !== "en" && next !== "zh-CN") return;
    const requestId = ++localeRequestRef.current;
    const applyLocale = async () => {
      try {
        if (next === "en") {
          const plugin = await loadEnglishLocale();
          if (localeRequestRef.current !== requestId) return;
          setMessages((current) => current.en ? current : { ...current, en: plugin.messages });
        }
      } catch {
        return;
      }
      if (localeRequestRef.current !== requestId) return;
      setLocaleState(next);
      setHydrated(true);
      document.documentElement.lang = next;
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // 存储失败不影响当前页面内的语言切换。
      }
    };
    void applyLocale();
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && (event.newValue === "en" || event.newValue === "zh-CN")) setLocale(event.newValue);
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [setLocale]);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [locale, messages]);
  const value = useMemo(() => ({ locale: hydrated ? locale : defaultLocale, setLocale, t, supportedLocales }), [hydrated, locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 获取当前组件树中的国际化能力。
 * @returns 当前 locale、翻译函数、语言切换函数和支持的语言列表
 * @throws 当组件不在 I18nProvider 内时抛出异常
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
