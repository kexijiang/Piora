"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppearanceThemeSettings } from "./AppearanceThemeSettings";
import { AppearanceResetButton } from "./AppearanceResetButton";
import { FontSettings } from "./FontSettings";
import { BackgroundSettings } from "./BackgroundSettings";
import { InterfaceTransparencySettings } from "./InterfaceTransparencySettings";
import styles from "./AppearanceSettings.module.css";

const TABS = ["theme", "font", "background", "transparency"] as const;
type AppearanceTab = typeof TABS[number];

export function AppearanceSettings() {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const id = useId();
  const [activeTab, setActiveTab] = useState<AppearanceTab>("theme");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
      : event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    event.preventDefault();
    setActiveTab(TABS[next]!);
    tabRefs.current[next]?.focus();
  }
  return (
    <div className={`${styles.appearance} settings-embedded-surface`}>
      <header className={styles.header}>
        <div><h2>{t("appearance.title")}</h2><p>{t("appearance.description")}</p></div>
        <AppearanceResetButton compact />
      </header>
      <div className={styles.tabs} role="tablist" aria-label={t("appearance.tabs.label")}>
        {TABS.map((tab, index) => <button key={tab} type="button" role="tab"
          id={`${id}-tab-${tab}`} aria-controls={`${id}-panel-${tab}`}
          aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
          ref={element => { tabRefs.current[index] = element; }}
          onClick={() => setActiveTab(tab)} onKeyDown={event => navigateTabs(event, index)}>
          {t(`appearance.tabs.${tab}`)}
        </button>)}
      </div>
      {/* Keep drafts mounted when switching tabs; settings search can reveal a hidden panel. */}
      {TABS.map(tab => <div key={tab} className={styles.panel} role="tabpanel" tabIndex={0}
        id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} hidden={activeTab !== tab}>
        {tab === "theme" && <>
          <section className={styles.languageSection} data-settings-id="language" aria-labelledby={`${id}-language-heading`}>
            <div><h3 id={`${id}-language-heading`}>{t("common.language")}</h3><p>{t("settings.languageDescription")}</p></div>
            <div className={styles.languageOptions} role="radiogroup" aria-label={t("common.language")}>
              {supportedLocales.map((option) => <button key={option.id} type="button" role="radio" aria-checked={locale === option.id} onClick={() => setLocale(option.id as typeof locale)}>{option.label}{locale === option.id ? <span aria-hidden="true">✓</span> : null}</button>)}
            </div>
          </section>
          <AppearanceThemeSettings />
        </>}
        {tab === "font" && <div data-settings-id="appearance.font"><FontSettings /></div>}
        {tab === "background" && <div data-settings-id="appearance.background"><BackgroundSettings className={styles.background} /></div>}
        {tab === "transparency" && <div data-settings-id="appearance.transparency"><InterfaceTransparencySettings /></div>}
      </div>)}
    </div>
  );
}
