import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./backgrounds.ts");
  } catch {
    return import("./backgrounds.ts");
  }
}

const subject = await loadSubject();
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(projectRoot, "public/themes/dream-backgrounds/manifest.json");
const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const expectedIds = [
  "aurora-glass",
  "sage-paper",
  "playful-doodle",
  "auspicious-cloud",
  "midnight-nebula",
  "cyber-teal",
  "watercolor-dawn",
  "ink-mountains",
  "wabi-sabi",
  "nordic-ice",
  "synthwave-grid",
  "bioluminescent-ocean",
  "moss-forest",
  "desert-sunset",
  "sakura-mist",
  "art-deco",
  "bauhaus",
  "linen-minimal",
  "rainy-bokeh",
  "celestial-parchment",
  "surreal-stillness",
  "riso-garden",
  "liquid-chrome",
  "soft-clay",
  "quantum-circuit",
  "white-future",
  "jade-ascension",
  "crimson-sword",
  "moonlit-beauty",
  "alpine-mirror",
  "kitty-candy",
  "cloud-bear",
  "anime-sky-campus",
  "anime-sakura-train",
  "anime-magic-library",
  "anime-neon-city",
  "anime-star-hangar",
];

test("reserves exactly 37 stable original background slots", () => {
  assert.deepEqual(subject.BACKGROUND_PRESETS.map(({ id }) => id), expectedIds);
  assert.equal(new Set(subject.BACKGROUND_PRESETS.map(({ asset }) => asset)).size, 37);
});

test("keeps all 37 completed backgrounds local-only and backed by real assets", () => {
  assert.equal(subject.BACKGROUND_MANIFEST.artworkStatus, "complete");
  assert.deepEqual(subject.BACKGROUND_MANIFEST.security, {
    remoteUrls: false,
    scripts: false,
    html: false,
    runtimeStyleInjection: false,
  });
  for (const preset of subject.BACKGROUND_PRESETS) {
    assert.equal(preset.artworkStatus, "available");
    assert.match(preset.asset, /^\/themes\/dream-backgrounds\/[a-z0-9-]+\.webp$/);
    assert.doesNotMatch(preset.asset, /:\/\//);
    assert.doesNotMatch(preset.fallback, /url\s*\(/i);
    assert.equal(existsSync(resolve(projectRoot, `public${preset.asset}`)), true, `${preset.id} is marked available without an asset`);
  }
});

test("rejects remote assets and CSS URL injection in manifests", () => {
  const remote = structuredClone(rawManifest);
  remote.presets[0].asset = "https://example.com/background.webp";
  assert.throws(() => subject.parseBackgroundManifest(remote), /Invalid bundled background preset/);

  const injected = structuredClone(rawManifest);
  injected.presets[0].fallback = "url(https://example.com/tracker.png)";
  assert.throws(() => subject.parseBackgroundManifest(injected), /Invalid bundled background preset/);
});

test("normalizes saved preferences and rejects unknown preset ids", () => {
  assert.deepEqual(subject.parseStoredBackgroundPreference(null), subject.DEFAULT_BACKGROUND_PREFERENCE);
  assert.deepEqual(subject.parseStoredBackgroundPreference("not json"), subject.DEFAULT_BACKGROUND_PREFERENCE);
  assert.deepEqual(
    subject.parseStoredBackgroundPreference(JSON.stringify({
      schemaVersion: 1,
      source: "builtin",
      presetId: "aurora-glass",
      overlay: 999,
      blur: -12,
      sidebarOverlay: -5,
      filePanelOverlay: 120,
    })),
    { schemaVersion: 1, source: "builtin", presetId: "aurora-glass", overlay: 90, blur: 0, sidebarOverlay: 0, filePanelOverlay: 90 },
  );
  assert.equal(
    subject.parseStoredBackgroundPreference(JSON.stringify({
      source: "builtin",
      presetId: "aurora-glass",
    })).sidebarOverlay,
    subject.DEFAULT_BACKGROUND_PREFERENCE.sidebarOverlay,
  );
  assert.equal(
    subject.parseStoredBackgroundPreference(JSON.stringify({
      source: "builtin",
      presetId: "aurora-glass",
    })).filePanelOverlay,
    subject.DEFAULT_BACKGROUND_PREFERENCE.filePanelOverlay,
  );
  assert.equal(
    subject.parseStoredBackgroundPreference(JSON.stringify({
      source: "builtin",
      presetId: "aurora-glass",
      filePanelOverlay: 40,
    })).filePanelOverlay,
    40,
  );
  assert.equal(subject.parseStoredBackgroundPreference(JSON.stringify({
    source: "builtin",
    presetId: "not-a-real-slot",
  })).source, "none");
});

test("detects only supported raster signatures", () => {
  assert.equal(subject.detectBackgroundImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(subject.detectBackgroundImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(subject.detectBackgroundImageMime(new TextEncoder().encode("RIFF0000WEBP")), "image/webp");
  assert.equal(subject.detectBackgroundImageMime(new TextEncoder().encode("0000ftypavif0000")), "image/avif");
  assert.equal(subject.detectBackgroundImageMime(new TextEncoder().encode("<svg><script>")), null);
});

test("accepts only bounded local raster data URLs for the storage fallback", () => {
  assert.equal(subject.isSafeCustomBackgroundDataUrl("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(subject.isSafeCustomBackgroundDataUrl("https://example.com/image.png"), false);
  assert.equal(subject.isSafeCustomBackgroundDataUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
});

test("downscales oversized custom backgrounds to a safe renderer budget", () => {
  assert.deepEqual(subject.fitCustomBackgroundForRendering(1920, 1080), { width: 1920, height: 1080 });
  const wide = subject.fitCustomBackgroundForRendering(12000, 4000);
  assert.ok(wide.width <= subject.CUSTOM_BACKGROUND_RENDER_MAX_DIMENSION);
  assert.ok(wide.height <= subject.CUSTOM_BACKGROUND_RENDER_MAX_DIMENSION);
  assert.ok(wide.width * wide.height <= subject.CUSTOM_BACKGROUND_RENDER_MAX_PIXELS);
  const square = subject.fitCustomBackgroundForRendering(7000, 7000);
  assert.ok(square.width * square.height <= subject.CUSTOM_BACKGROUND_RENDER_MAX_PIXELS);
});

test("exposes every bundled background through the thumbnail picker", () => {
  const source = readFileSync(resolve(projectRoot, "components/BackgroundSettings.tsx"), "utf8");
  const styles = readFileSync(resolve(projectRoot, "components/BackgroundSettings.module.css"), "utf8");
  assert.match(source, /presets\.map\(\(preset\)\s*=>/);
  assert.match(source, /data-background-preset=\{preset\.id\}/);
  assert.match(source, /role="radiogroup"/);
  assert.match(styles, /\.presetGrid\s*\{[^}]*grid-template-columns:/s);
});

test("keeps the workspace transparent while a local background is active", () => {
  const css = readFileSync(resolve(projectRoot, "app/theme-backgrounds.css"), "utf8");
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.workspace-main\s*\{[^}]*background:\s*transparent\s*!important/s,
  );
});

test("keeps the settings canvas on the shared background layer", () => {
  const source = readFileSync(resolve(projectRoot, "components/SettingsDialog.tsx"), "utf8");
  const css = readFileSync(resolve(projectRoot, "app/theme-backgrounds.css"), "utf8");
  for (const className of [
    "settings-backdrop",
    "settings-dialog",
    "settings-navigation",
    "settings-content",
    "settings-embedded-section",
  ]) {
    assert.match(source, new RegExp(className));
  }
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.settings-backdrop\s*\{[^}]*isolation:\s*isolate[^}]*background:\s*var\(--bg\)\s*!important/s,
  );
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.settings-backdrop::before\s*\{[^}]*background-image:\s*var\(--app-background-image,[^}]*filter:\s*blur\(var\(--app-background-blur/s,
  );
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.settings-backdrop::after\s*\{[^}]*--app-background-overlay/s,
  );
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.settings-dialog\s*\{[^}]*z-index:\s*1[^}]*background:\s*transparent\s*!important/s,
  );
  assert.match(
    css,
    /html\[data-app-background-active=["']true["']\]\s+\.settings-navigation\s*\{[^}]*--app-background-sidebar-overlay/s,
  );
});

test("applies side-panel wallpaper washes only once", () => {
  const css = readFileSync(resolve(projectRoot, "app/theme-backgrounds.css"), "utf8");
  assert.match(
    css,
    /data-app-background-active=["']true["']\]\s+\.session-sidebar-content\s*\{[^}]*background:\s*transparent\s*!important/s,
  );
  assert.match(
    css,
    /data-app-background-active=["']true["']\]\s+#file-panel\s+\.right-panel-surface\s*\{[^}]*background:\s*transparent\s*!important/s,
  );
  assert.match(css, /--file-panel-surface:\s*transparent/);
  assert.match(css, /--file-panel-surface-panel:\s*transparent/);
});

test("prepaints a saved built-in background before React hydration", () => {
  const properties = new Map();
  const root = {
    dataset: {},
    style: { setProperty: (name, value) => properties.set(name, value) },
  };
  const localStorage = {
    getItem: (key) => key === subject.BACKGROUND_PREFERENCE_STORAGE_KEY
      ? JSON.stringify({ source: "builtin", presetId: "aurora-glass", overlay: 72, blur: 3, sidebarOverlay: 44 })
      : null,
  };
  new Function("document", "localStorage", subject.BACKGROUND_INITIALIZATION_SCRIPT)(
    { documentElement: root },
    localStorage,
  );
  assert.equal(root.dataset.appBackgroundActive, "true");
  assert.equal(root.dataset.appBackgroundPreset, "aurora-glass");
  assert.equal(properties.get("--app-background-image"), 'url("/themes/dream-backgrounds/aurora-glass.webp")');
  assert.equal(properties.get("--app-background-overlay"), "72%");
  assert.equal(properties.get("--app-background-sidebar-overlay"), "44%");
  assert.equal(properties.get("--app-background-blur"), "3px");
  const layout = readFileSync(resolve(projectRoot, "app/layout.tsx"), "utf8");
  assert.match(layout, /BACKGROUND_INITIALIZATION_SCRIPT/);
});
