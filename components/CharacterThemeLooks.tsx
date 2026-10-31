"use client";

import { useEffect, useId, useState } from "react";
import { CHARACTER_THEMES, CHARACTER_THEME_GROUPS, type CharacterThemeGroup } from "@/lib/character-themes";
import { parsePreviousCharacterAppearance, PREVIOUS_CHARACTER_APPEARANCE_KEY, type PreviousCharacterAppearance } from "@/lib/character-appearance";
import { useTheme } from "@/hooks/useTheme";
import { useBackground } from "@/hooks/useBackground";
import { useI18n } from "@/hooks/useI18n";
import styles from "./CharacterThemeLooks.module.css";

export function CharacterThemeLooks() {
  const titleId = useId();
  const { t } = useI18n();
  const { theme, setThemeWithAction } = useTheme();
  const { preference, hydrated, busy, hasStoredCustom, applyBuiltinPreset, selectStoredCustom, setNone } = useBackground();
  const [group, setGroup] = useState<CharacterThemeGroup | "all">("all");
  const [previous, setPrevious] = useState<PreviousCharacterAppearance | null>(null);
  useEffect(() => {
    try { setPrevious(parsePreviousCharacterAppearance(localStorage.getItem(PREVIOUS_CHARACTER_APPEARANCE_KEY))); } catch { /* Storage is optional. */ }
  }, []);

  const remember = () => {
    // Keep the original look while browsing character variants. Capture a new
    // baseline when coming back from a normal palette or another background.
    if (previous && theme.startsWith("character-") && preference.presetId?.startsWith("character-")) return;
    const value = { theme, background: { ...preference } };
    setPrevious(value);
    try { localStorage.setItem(PREVIOUS_CHARACTER_APPEARANCE_KEY, JSON.stringify(value)); } catch { /* In-memory restore remains available. */ }
  };

  const restore = () => {
    if (!previous) return;
    const saved = previous;
    setThemeWithAction(saved.theme, () => {
      if (saved.background.source === "builtin" && saved.background.presetId) {
        applyBuiltinPreset(saved.background.presetId, saved.background);
      } else if (saved.background.source === "custom") {
        void selectStoredCustom(saved.background);
      } else {
        setNone(saved.background);
      }
    });
    // Retain the record so storage/image failures can be retried without losing it.
  };

  return <section className={styles.section} aria-labelledby={titleId}>
    <div className={styles.heading}>
      <div><h3 id={titleId}>{t("appearance.characters.title")} <span>{CHARACTER_THEMES.length}</span></h3><p>{t("appearance.characters.hint")}</p></div>
      {previous && <button type="button" className={styles.restore} onClick={restore} disabled={!hydrated || busy || (previous.background.source === "custom" && !hasStoredCustom)}>{t("appearance.characters.restore")}</button>}
    </div>
    <div className={styles.groups} role="group" aria-label={t("appearance.characters.title")}>
      <button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>{t("appearance.characters.all")}</button>
      {CHARACTER_THEME_GROUPS.map(({ id }) => <button type="button" key={id} aria-pressed={group === id} data-character-group={id} onClick={() => setGroup(id)}>{t(`appearance.characters.group.${id}`)}</button>)}
    </div>
    <div className={styles.grid} role="group" aria-label={t("appearance.characters.title")}>
      {CHARACTER_THEMES.filter(look => group === "all" || look.group === group).map(look => {
        const selected = theme === look.id && preference.source === "builtin" && preference.presetId === look.id
          && preference.overlay === look.overlay && preference.blur === look.blur
          && preference.sidebarOverlay === look.sidebarOverlay && preference.filePanelOverlay === look.filePanelOverlay;
        return <button key={look.id} type="button" className={styles.card} aria-pressed={selected} data-appearance-look={look.id} disabled={!hydrated || busy}
          onClick={event => {
            remember();
            const rect = event.currentTarget.getBoundingClientRect();
            setThemeWithAction(look.id, () => applyBuiltinPreset(look.id, look), { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }}>
          <span className={styles.artwork} style={{ backgroundColor: look.colors.bg }}>
            {/* Pre-encoded local WebP; avoid an optimizer server for desktop/offline assets. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={look.asset} alt="" loading="lazy" width={1672} height={941} />
            {selected && <span className={styles.check} aria-hidden="true">✓</span>}
          </span>
          <span className={styles.caption}><span>{t(`theme.${look.id}.name`)}</span><small>{t(look.isDark ? "appearance.characters.dark" : "appearance.characters.light")}</small></span>
          <span className={styles.colors} aria-hidden="true">{Object.values(look.colors).map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>
        </button>;
      })}
    </div>
    <a className={styles.credits} href="/themes/character-backgrounds/NOTICE.md" target="_blank" rel="noreferrer">{t("appearance.characters.credits")} ↗</a>
  </section>;
}
