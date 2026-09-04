"use client";

import { useEffect, useId, useState } from "react";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useI18n } from "@/hooks/useI18n";
import {
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  isUiFontSize,
} from "@/lib/font-preferences";
import { AliIcon } from "./AliIcon";
import { LazyMarkdownBody } from "./LazyMarkdownBody";

export function FontSettings() {
  const titleId = useId();
  const sizeId = useId();
  const weightId = useId();
  const { t } = useI18n();
  const { preference, presets, sizes, weights, setFamily, setSize, setWeight, reset } = useFontPreferences();
  const [fontAvailability, setFontAvailability] = useState<Record<string, boolean>>({ system: true });
  const [sizeDraft, setSizeDraft] = useState(String(preference.size));

  useEffect(() => {
    setSizeDraft(String(preference.size));
  }, [preference.size]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!document.fonts) return;
      const next: Record<string, boolean> = { system: true };
      await Promise.all(presets.map(async (preset) => {
        if (!preset.checkFamily) return;
        const descriptor = `12px "${preset.checkFamily}"`;
        try {
          await document.fonts.load(descriptor);
          next[preset.id] = document.fonts.check(descriptor);
        } catch {
          next[preset.id] = false;
        }
      }));
      if (!cancelled) setFontAvailability(next);
    })();
    return () => { cancelled = true; };
  }, [presets]);

  const commitSizeDraft = () => {
    const nextSize = Number(sizeDraft.trim());
    if (!isUiFontSize(nextSize)) {
      setSizeDraft(String(preference.size));
      return;
    }
    setSize(nextSize);
    setSizeDraft(String(nextSize));
  };

  return (
    <section className="soft-settings-section" aria-labelledby={titleId} style={{ padding: "16px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 9 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 id={titleId} style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 700 }}>
            {t("appearance.font.title")}
          </h3>
          <p style={{ margin: "2px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
            {t("appearance.font.hint")}
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          style={{
            minHeight: 28,
            padding: "4px 9px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "var(--text-xs)",
          }}
        >
          {t("appearance.font.reset")}
        </button>
      </div>

      <div
        role="radiogroup"
        aria-label={t("appearance.font.family")}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 7 }}
      >
        {presets.map((preset) => {
          const selected = preference.family === preset.id;
          const unavailable = fontAvailability[preset.id] === false;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable}
              data-ui-font-choice={preset.id}
              onClick={() => setFamily(preset.id)}
              style={{
                minWidth: 0,
                minHeight: 50,
                padding: "7px 9px",
                display: "flex",
                alignItems: "center",
                gap: 9,
                border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: selected ? "var(--bg-selected)" : "var(--bg)",
                color: "var(--text)",
                cursor: unavailable ? "not-allowed" : "pointer",
                opacity: unavailable ? 0.52 : 1,
                textAlign: "left",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 34,
                  height: 34,
                  display: "grid",
                  placeItems: "center",
                  flex: "0 0 34px",
                  borderRadius: 7,
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontFamily: preset.previewFamily,
                  fontSize: "var(--text-md)",
                }}
              >
                Aa
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: preset.previewFamily, fontSize: "var(--text-xs)", fontWeight: 600 }}>
                  {t(preset.nameKey)}
                </span>
                <span style={{ display: "block", marginTop: 2, color: unavailable ? "#b45309" : "var(--text-dim)", fontFamily: preset.previewFamily, fontSize: "var(--text-xs)" }}>
                  {unavailable
                    ? t("appearance.font.unavailable")
                    : `${t("appearance.font.preview")} · ${t(`appearance.font.source.${preset.source}`)}`}
                </span>
              </span>
              {selected && (
                <AliIcon name="check" size={13} style={{ color: "var(--accent)" }} />
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        <span id={sizeId} style={{ minWidth: 64, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
          {t("appearance.font.size")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={sizeId}
          style={{ display: "inline-flex", flexWrap: "wrap", padding: 2, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)" }}
        >
          {sizes.map((size) => {
            const selected = preference.size === size;
            return (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={selected}
                data-ui-font-size-choice={size}
                onClick={() => setSize(size)}
                style={{
                  width: 38,
                  height: 28,
                  padding: 0,
                  border: "none",
                  borderRadius: 5,
                  background: selected ? "var(--bg-selected)" : "transparent",
                  color: selected ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: "var(--text-xs)",
                  fontWeight: selected ? 650 : 500,
                }}
              >
                {size}
              </button>
            );
          })}
        </div>
        <label className="font-size-custom-field">
          <span>{t("appearance.font.customSize")}</span>
          <input
            type="number"
            min={UI_FONT_SIZE_MIN}
            max={UI_FONT_SIZE_MAX}
            step={1}
            inputMode="numeric"
            value={sizeDraft}
            aria-label={t("appearance.font.customSize")}
            aria-describedby={sizeId}
            onChange={(event) => setSizeDraft(event.target.value)}
            onBlur={commitSizeDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setSizeDraft(String(preference.size));
                event.currentTarget.blur();
              }
            }}
          />
          <span aria-hidden="true">px</span>
        </label>
        <span style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
          {t("appearance.font.sizeRange", { min: UI_FONT_SIZE_MIN, max: UI_FONT_SIZE_MAX })}
        </span>
      </div>
      <div className="font-weight-setting">
        <span id={weightId}>{t("appearance.font.weight")}</span>
        <div className="font-weight-options" role="radiogroup" aria-labelledby={weightId}>
          {weights.map((weight) => (
            <label key={weight} className="font-weight-option" style={{ fontWeight: weight }}>
              <input
                type="radio"
                name={weightId}
                value={weight}
                checked={preference.weight === weight}
                data-ui-font-weight-choice={weight}
                onChange={() => setWeight(weight)}
              />
              {t(`appearance.font.weight.${weight}`)}
            </label>
          ))}
        </div>
        <span className="font-weight-hint">{t("appearance.font.weightHint")}</span>
      </div>

      <div className="font-reading-preview">
        <p className="font-reading-preview-label">{t("appearance.font.readingPreview")}</p>
        <LazyMarkdownBody className="markdown-assistant-message">
          {t("appearance.font.readingSample")}
        </LazyMarkdownBody>
      </div>
    </section>
  );
}
