import { boundedJson } from "./json";
import { readMiniAppResource } from "./resource";

const fallbackColors = {
  "--bg": "#ffffff", "--bg-panel": "#f5f7fa", "--bg-hover": "#edf1f5",
  "--bg-selected": "#e2ecf7", "--border": "#d6dee7", "--text": "#1d2a36",
  "--text-muted": "#536575", "--text-dim": "#71818e", "--accent": "#246a84",
} as const;
type ColorToken = keyof typeof fallbackColors;
export interface MiniAppAppearance {
  colors: Record<ColorToken, string>;
  colorScheme: "light" | "dark";
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  reducedMotion: boolean;
}

/** Values come from the host's computed appearance, never generated markup. */
export function readMiniAppAppearance(): MiniAppAppearance {
  const root = document.documentElement, style = getComputedStyle(root);
  const colors = { ...fallbackColors } as Record<ColorToken, string>;
  for (const key of Object.keys(colors) as ColorToken[]) {
    const value = style.getPropertyValue(key).trim();
    if (value && value.length <= 256 && CSS.supports("color", value)) colors[key] = value;
  }
  const size = Number.parseFloat(style.getPropertyValue("--ui-font-size"));
  const weight = Number.parseInt(style.getPropertyValue("--ui-font-weight"), 10);
  const family = style.getPropertyValue("--ui-font-family").trim() || getComputedStyle(document.body).fontFamily;
  return {
    colors, colorScheme: style.colorScheme === "dark" || root.classList.contains("dark") ? "dark" : "light",
    fontFamily: family && family.length <= 512 && CSS.supports("font-family", family) ? family : "system-ui",
    fontSize: Number.isFinite(size) ? Math.max(10, Math.min(48, size)) : 16,
    fontWeight: [400, 500, 700].includes(weight) ? weight : 400,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

/** Observe app settings and late theme-pack styles without coupling to React stores. */
export function observeMiniAppAppearance(update: (value: MiniAppAppearance) => void): () => void {
  let previous = "", scheduled: ReturnType<typeof setTimeout> | undefined, closed = false;
  const flush = () => {
    scheduled = undefined;
    if (closed) return;
    const value = readMiniAppAppearance(), signature = JSON.stringify(value);
    if (signature !== previous) { previous = signature; update(value); }
  };
  const schedule = () => { if (!closed && scheduled === undefined) scheduled = setTimeout(flush, 0); };
  const rootObserver = new MutationObserver(schedule), headObserver = new MutationObserver(schedule);
  rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-ui-font", "data-ui-font-size", "data-ui-font-weight"] });
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "media", "disabled"] });
  document.head.addEventListener("load", schedule, true);
  const motion = matchMedia("(prefers-reduced-motion: reduce)"); motion.addEventListener("change", schedule);
  flush();
  return () => {
    closed = true; rootObserver.disconnect(); headObserver.disconnect();
    if (scheduled !== undefined) clearTimeout(scheduled);
    document.head.removeEventListener("load", schedule, true); motion.removeEventListener("change", schedule);
  };
}

/** The private port accepts a fixed set of CSS values, not CSS text or URLs. */
export function applyMiniAppAppearance(value: MiniAppAppearance): void {
  boundedJson(value, 8192);
  if (!value || !value.colors || !["light", "dark"].includes(value.colorScheme)
    || !Number.isFinite(value.fontSize) || value.fontSize < 10 || value.fontSize > 48
    || ![400, 500, 700].includes(value.fontWeight) || typeof value.reducedMotion !== "boolean"
    || typeof value.fontFamily !== "string" || value.fontFamily.length > 512 || !CSS.supports("font-family", value.fontFamily)) throw new Error("APPEARANCE");
  const root = document.documentElement;
  for (const key of Object.keys(fallbackColors) as ColorToken[]) {
    const color = value.colors[key];
    if (typeof color !== "string" || color.length > 256 || !CSS.supports("color", color)) throw new Error("APPEARANCE");
    root.style.setProperty(key, color);
  }
  root.style.colorScheme = value.colorScheme;
  root.style.fontFamily = value.fontFamily;
  root.style.fontSize = `${value.fontSize}px`;
  root.style.fontWeight = String(value.fontWeight);
  root.dataset.reducedMotion = String(value.reducedMotion);
}

export interface MiniAppFont { weight: "400" | "500" | "600"; style: "normal" | "italic"; data: string }
const bundledFonts = [["400", "normal"], ["400", "italic"], ["500", "normal"], ["600", "normal"]] as const;

/** Only app-owned, fixed local font assets can cross the boundary as bytes. */
export async function loadMiniAppFonts(signal: AbortSignal): Promise<MiniAppFont[]> {
  return Promise.all(bundledFonts.map(async ([weight, style]) => {
    const response = await fetch(`/fonts/inter/inter-latin-${weight}-${style}.woff2`, { signal, credentials: "same-origin", redirect: "error" });
    const bytes = await readMiniAppResource(response, 64 * 1024);
    return { weight, style, data: btoa(String.fromCharCode(...bytes)) };
  }));
}

export async function applyMiniAppFonts(fonts: MiniAppFont[]): Promise<void> {
  if (!Array.isArray(fonts) || fonts.length !== 4) throw new Error("FONT");
  await Promise.all(fonts.map(async (font, index) => {
    if (font.weight !== bundledFonts[index][0] || font.style !== bundledFonts[index][1]
      || typeof font.data !== "string" || font.data.length > 90_000) throw new Error("FONT");
    const bytes = Uint8Array.from(atob(font.data), char => char.charCodeAt(0));
    const face = new FontFace("Inter", bytes, { weight: font.weight, style: font.style, display: "swap" });
    await face.load(); document.fonts.add(face);
  }));
}
