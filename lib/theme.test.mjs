import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("../hooks/useTheme.ts");
  } catch {
    return import("../hooks/useTheme.ts");
  }
}

const {
  THEME_PRESETS,
  THEME_INITIALIZATION_SCRIPT,
  isDarkTheme,
  parseStoredTheme,
  serializeThemePreference,
} = await loadSubject();
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

test("marks the Dream Skin preset as a bundled UI theme pack", () => {
  assert.equal(THEME_PRESETS.find(({ id }) => id === "dream")?.packId, "codex-dream-skin");
});

test("exposes the built-in theme presets in a stable order", () => {
  assert.deepEqual(THEME_PRESETS.map(({ id }) => id), [
    "light",
    "dark",
    "starlight",
    "ivory",
    "doodle",
    "fortune",
    "nordic",
    "sakura",
    "kitty",
    "cloud-bear",
    "anime-sky",
    "anime-sakura",
    "anime-magic",
    "anime-neon",
    "anime-star",
    "midnight",
    "forest",
    "cyber",
    "ember",
    "dream",
  ]);
});

test("reads legacy plain theme values", () => {
  assert.equal(parseStoredTheme("light"), "light");
  assert.equal(parseStoredTheme("dark"), "dark");
});

test("round-trips the versioned theme preference payload", () => {
  for (const { id } of THEME_PRESETS) {
    assert.equal(parseStoredTheme(serializeThemePreference(id)), id);
  }
});

test("restores every persisted theme before hydration after an app restart", () => {
  for (const preset of THEME_PRESETS) {
    const classes = new Set();
    const documentElement = {
      dataset: {},
      style: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute(name, value) {
        if (name === "data-theme") this.dataset.theme = value;
      },
    };
    const storage = new Map([
      ["pi-theme:v1", serializeThemePreference(preset.id)],
      ["pi-theme", preset.isDark ? "dark" : "light"],
    ]);
    vm.runInNewContext(THEME_INITIALIZATION_SCRIPT, {
      document: { documentElement },
      localStorage: { getItem: (key) => storage.get(key) ?? null },
    });
    assert.equal(documentElement.dataset.theme, preset.id);
    assert.equal(classes.has("dark"), preset.isDark);
    assert.equal(documentElement.style.colorScheme, preset.isDark ? "dark" : "light");
  }

  const layout = readFileSync(resolve(projectRoot, "app/layout.tsx"), "utf8");
  assert.match(layout, /THEME_INITIALIZATION_SCRIPT/);
  assert.doesNotMatch(layout, /const themeInitializationScript/);
});

test("rejects malformed and unknown stored preferences", () => {
  assert.equal(parseStoredTheme(null), null);
  assert.equal(parseStoredTheme("not-json"), null);
  assert.equal(parseStoredTheme('{"theme":"unknown"}'), null);
  assert.equal(parseStoredTheme('{"theme":'), null);
});

test("marks every dark palette, including custom presets, as dark", () => {
  assert.equal(isDarkTheme("light"), false);
  assert.equal(isDarkTheme("starlight"), false);
  assert.equal(isDarkTheme("ivory"), false);
  assert.equal(isDarkTheme("doodle"), false);
  assert.equal(isDarkTheme("fortune"), false);
  assert.equal(isDarkTheme("nordic"), false);
  assert.equal(isDarkTheme("sakura"), false);
  assert.equal(isDarkTheme("kitty"), false);
  assert.equal(isDarkTheme("cloud-bear"), false);
  assert.equal(isDarkTheme("anime-sky"), false);
  assert.equal(isDarkTheme("anime-sakura"), false);
  assert.equal(isDarkTheme("anime-magic"), true);
  assert.equal(isDarkTheme("anime-neon"), true);
  assert.equal(isDarkTheme("anime-star"), true);
  assert.equal(isDarkTheme("dark"), true);
  assert.equal(isDarkTheme("midnight"), true);
  assert.equal(isDarkTheme("forest"), true);
  assert.equal(isDarkTheme("cyber"), true);
  assert.equal(isDarkTheme("ember"), true);
  assert.equal(isDarkTheme("dream"), true);
});

test("keeps the imported Dream palette more specific than generic dark mode", () => {
  const css = readFileSync(resolve(projectRoot, "public/themes/codex-dream-skin/skin.css"), "utf8");
  assert.match(css, /html\.dark\[data-theme=["']dream["']\]\s*\{/);
  assert.doesNotMatch(css, /(?:^|\n)html\[data-theme=["']dream["']\]\s*\{/);
});

test("keeps appearance discoverable inside the consolidated settings page, but not duplicate menus", () => {
  const source = readFileSync(resolve(projectRoot, "components/AppShell.tsx"), "utf8");
  const settingsSource = readFileSync(resolve(projectRoot, "components/SettingsDialog.tsx"), "utf8");
  const desktopSource = readFileSync(resolve(projectRoot, "desktop/src/main.ts"), "utf8");
  assert.equal((desktopSource.match(/sendMenuAction\("settings"\)/g) ?? []).length, 1);
  assert.doesNotMatch(desktopSource, /sendMenuAction\("appearance"\)/);
  assert.match(settingsSource, /key:\s*"appearance"/);
  assert.match(settingsSource, /onActiveKeyChange\(entry\.key\)/);
  assert.match(source, /appearance:\s*\([\s\S]*?<AppearanceLooks \/>/);
  assert.doesNotMatch(source, /openAppearanceSettings|onOpenAppearance/);
  assert.doesNotMatch(source, /sidebar-user-menu/);
  assert.doesNotMatch(source, /themeBtnRef|app-topbar-appearance/);
  assert.match(settingsSource, /role="dialog"/);
  assert.match(settingsSource, /aria-modal="true"/);
  assert.match(settingsSource, /createPortal/);
  assert.doesNotMatch(source, /appearanceDialogOpen/);
  assert.match(source, /data-theme-id=\{preset\.id\}/);
});

test("offers a wallpaper-free Codex look alongside all twenty-five one-click artwork looks", () => {
  const source = readFileSync(resolve(projectRoot, "components/AppearanceLooks.tsx"), "utf8");
  assert.match(source, /id:\s*"codex"[\s\S]*theme:\s*"dream"[\s\S]*backgroundId:\s*null/);
  assert.match(source, /starlight[\s\S]*aurora-glass/);
  assert.match(source, /ivory[\s\S]*sage-paper/);
  assert.match(source, /doodle[\s\S]*playful-doodle/);
  assert.match(source, /fortune[\s\S]*auspicious-cloud/);
  assert.match(source, /nordic[\s\S]*nordic-ice/);
  assert.match(source, /sakura[\s\S]*sakura-mist/);
  assert.match(source, /cyber[\s\S]*cyber-teal/);
  assert.match(source, /ember[\s\S]*desert-sunset/);
  assert.match(source, /surreal[\s\S]*surreal-stillness/);
  assert.match(source, /riso[\s\S]*riso-garden/);
  assert.match(source, /liquid-chrome[\s\S]*liquid-chrome/);
  assert.match(source, /soft-clay[\s\S]*soft-clay/);
  assert.match(source, /quantum[\s\S]*quantum-circuit/);
  assert.match(source, /white-future[\s\S]*white-future/);
  assert.match(source, /jade[\s\S]*jade-ascension/);
  assert.match(source, /crimson[\s\S]*crimson-sword/);
  assert.match(source, /moonlit[\s\S]*moonlit-beauty/);
  assert.match(source, /alpine[\s\S]*alpine-mirror/);
  assert.match(source, /kitty[\s\S]*kitty-candy/);
  assert.match(source, /cloud-bear[\s\S]*cloud-bear/);
  assert.match(source, /anime-sky[\s\S]*anime-sky-campus/);
  assert.match(source, /anime-sakura[\s\S]*anime-sakura-train/);
  assert.match(source, /anime-magic[\s\S]*anime-magic-library/);
  assert.match(source, /anime-neon[\s\S]*anime-neon-city/);
  assert.match(source, /anime-star[\s\S]*anime-star-hangar/);
  assert.match(source, /applyBuiltinPreset/);
  assert.match(source, /sidebarOverlay:\s*look\.sidebarOverlay/);
  assert.match(source, /filePanelOverlay:\s*look\.filePanelOverlay/);
  assert.match(source, /setNone\(\)/);
  assert.match(source, /data-appearance-look=\{look\.id\}/);
  assert.match(source, /CUSTOM_LOOK_STORAGE_KEY/);
  assert.match(source, /data-appearance-look="custom"/);
  assert.match(source, /uploadCustom\(file\)/);
  assert.match(source, /selectStoredCustom\(customLook\)/);
});

test("offers one action that restores every appearance preference", () => {
  const source = readFileSync(resolve(projectRoot, "components/AppearanceResetButton.tsx"), "utf8");
  const shell = readFileSync(resolve(projectRoot, "components/AppShell.tsx"), "utf8");
  assert.match(shell, /<AppearanceResetButton \/>/);
  assert.match(source, /setTheme\("light"\)/);
  assert.match(source, /resetFont\(\)/);
  assert.match(source, /await resetBackground\(\)/);
  assert.match(source, /data-appearance-reset/);
});

test("keeps small text and links readable on every light visual look", () => {
  const css = readFileSync(resolve(projectRoot, "app/globals.css"), "utf8");
  for (const theme of ["starlight", "ivory", "doodle", "fortune", "nordic", "sakura", "kitty", "cloud-bear", "anime-sky", "anime-sakura"]) {
    const block = css.match(new RegExp(`html\\[data-theme=["']${theme}["']\\]\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(block, `missing ${theme} theme block`);
    const readToken = (name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    const background = readToken("bg");
    const dimText = readToken("text-dim");
    const accent = readToken("accent");
    assert.ok(background && dimText && accent, `missing contrast tokens for ${theme}`);
    assert.ok(contrastRatio(background, dimText) >= 4.5, `${theme} dim text is too faint`);
    assert.ok(contrastRatio(background, accent) >= 4.5, `${theme} accent is too faint`);
  }
});

test("emphasis and highlighted text meet contrast requirements in every theme", () => {
  const css = readFileSync(resolve(projectRoot, "app/globals.css"), "utf8");
  const dream = readFileSync(resolve(projectRoot, "public/themes/codex-dream-skin/skin.css"), "utf8");
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => [match[1], match[2]]));
  const base = tokens(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
  const dark = tokens(css.match(/html\.dark\s*\{([\s\S]*?)\n\}/)[1]);
  const mix = (a, b, weight) => '#' + [1, 3, 5].map((offset) => Math.round(parseInt(a.slice(offset, offset + 2), 16) * weight + parseInt(b.slice(offset, offset + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
  for (const preset of THEME_PRESETS) {
    const block = preset.id === 'dream' ? dream : css.match(new RegExp(`html\\[data-theme="${preset.id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    const palette = { ...base, ...(preset.isDark ? dark : {}), ...tokens(block) };
    const emphasis = mix(palette.text, palette.accent, 0.8);
    const conclusionColors = [
      mix(palette.text, palette.accent, 0.45),
      mix(palette.text, mix('#8b5cf6', palette.accent, 0.85), 0.45),
      mix(palette.text, mix('#0891b2', palette.accent, 0.85), 0.45),
    ];
    for (const color of conclusionColors) {
      assert.ok(contrastRatio(color, palette.bg) >= 4.5, `${preset.id} conclusion ${color} contrast`);
    }
    const highlight = mix(palette.text, palette['status-attention'], 0.8);
    assert.ok(contrastRatio(emphasis, palette.bg) >= 4.5, `${preset.id} emphasis contrast`);
    assert.ok(contrastRatio(highlight, mix(highlight, palette.bg, 0.18)) >= 4.5, `${preset.id} highlight contrast`);
  }
});
