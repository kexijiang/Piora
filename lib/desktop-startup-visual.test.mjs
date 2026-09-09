import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";

const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopMain = await readFile(join(repositoryRoot, "desktop", "src", "main.ts"), "utf8");
const startup = await createJiti(import.meta.url).import("../desktop/src/startup-scene.ts");
const splashGenerator = await readFile(join(repositoryRoot, "scripts", "generate-portable-splash.ps1"), "utf8");

function readBitmapPixel(buffer, x, y) {
  assert.equal(buffer.toString("ascii", 0, 2), "BM");
  const pixelOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  const bitsPerPixel = buffer.readUInt16LE(28);
  assert.equal(bitsPerPixel, 32, "portable splash must stay a 32-bit bitmap");
  assert.ok(x >= 0 && x < width && y >= 0 && y < Math.abs(height));
  const storedY = height > 0 ? height - 1 - y : y;
  const offset = pixelOffset + (storedY * width + x) * 4;
  return [buffer[offset + 2], buffer[offset + 1], buffer[offset]];
}

test("Electron startup cinematic stays local, escapable, muted and motion-aware", () => {
  const document = startup.createStartupDocument({ chinese: true, updated: true, version: '<bad>&"', video: 'data:video/mp4;base64,AA==', poster: 'data:image/jpeg;base64,AA==' });
  assert.match(desktopMain, /STARTUP_SHELL_BACKGROUND = "#080a0f"/);
  assert.match(document, /autoplay muted playsinline/);
  assert.match(document, /media-src data:/);
  assert.match(document, /prefers-reduced-motion/);
  assert.match(document, /clip\?\.pause\(\)/);
  assert.match(document, /piora-startup:\/\/continue/);
  assert.match(document, /&lt;bad&gt;&amp;&quot;/);
  assert.match(document, /更新就绪/);
  assert.match(desktopMain, /await startup\.finished;\s*await loadApplicationWindow/);
  assert.match(desktopMain, /!firstLaunchOfVersion \|\| !media\.video \|\| PORTABLE_SMOKE_TEST/);
  assert.match(desktopMain, /setTimeout\(finishIntro, STARTUP_MEDIA_TIMEOUT_MS\)/);
  assert.equal(startup.STARTUP_CINEMATIC_MS, 8000);
  assert.equal(startup.STARTUP_MEDIA_TIMEOUT_MS, 10000);
  assert.match(document, /class="film"/);
  assert.match(document, /\.film \.scene\{object-fit:contain\}/);
  assert.match(document, /addEventListener\('ended',continueStartup/);
  const fallback = startup.createStartupDocument({ chinese: false, updated: false, version: '1.0.0' });
  assert.doesNotMatch(fallback, /<video/);
  assert.match(fallback, /Starting Piora/);
});

test("intro playback completion, media failure and reduced motion all release startup", () => {
  const document = startup.createStartupDocument({ chinese: false, updated: true, version: '1.0.0', video: 'data:video/mp4;base64,AA==' });
  const script = document.match(/<script nonce="piora-startup">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  function playback(reducedMotion = false) {
    const handlers = new Map();
    const changes = new Map();
    let pauses = 0;
    const clip = { pause: () => { pauses++; }, addEventListener: (name, handler) => handlers.set(name, handler) };
    const motion = { matches: reducedMotion, addEventListener: (name, handler) => changes.set(name, handler) };
    const location = { href: '' };
    runInNewContext(script, { document: { querySelector: () => clip }, matchMedia: () => motion, location });
    return { handlers, changes, motion, location, pauses: () => pauses };
  }
  for (const event of ['ended', 'error']) {
    const player = playback();
    assert.equal(player.location.href, '');
    player.handlers.get(event)();
    assert.equal(player.location.href, startup.STARTUP_CONTINUE_URL);
  }
  const reduced = playback(true);
  assert.equal(reduced.pauses(), 1);
  assert.equal(reduced.location.href, startup.STARTUP_CONTINUE_URL);
  const changed = playback();
  changed.motion.matches = true;
  changed.changes.get('change')();
  assert.equal(changed.pauses(), 1);
  assert.equal(changed.location.href, startup.STARTUP_CONTINUE_URL);
});

test("portable pre-extraction splash is generated from the same layered visual language", () => {
  assert.match(splashGenerator, /LinearGradientBrush/);
  assert.match(splashGenerator, /#080A0F/);
  assert.match(splashGenerator, /#101522/);
  assert.match(splashGenerator, /New-RoundedRectanglePath/);
  assert.match(splashGenerator, /for \(\$x = 0; \$x -le 520; \$x \+= 26\)/);
  assert.match(splashGenerator, /STARTING PIORA/);
  assert.match(splashGenerator, /LOCAL-FIRST/);
});

test("committed portable splash contains visibly distinct background and panel layers", async () => {
  const bitmap = await readFile(join(repositoryRoot, "desktop", "build", "portable-splash.bmp"));
  assert.equal(bitmap.readInt32LE(18), 520);
  assert.equal(Math.abs(bitmap.readInt32LE(22)), 300);

  const outerTop = readBitmapPixel(bitmap, 8, 8);
  const outerBottom = readBitmapPixel(bitmap, 510, 290);
  const panelCenter = readBitmapPixel(bitmap, 260, 150);
  const panelTop = readBitmapPixel(bitmap, 260, 30);
  const colors = new Set([outerTop, outerBottom, panelCenter, panelTop].map((rgb) => rgb.join(",")));

  assert.ok(colors.size >= 4, `startup layers collapsed into too few colors: ${[...colors].join(" | ")}`);
  assert.ok(outerTop.some((channel) => channel > 8), "outer background must not be pure black");
  assert.notDeepEqual(panelCenter, outerTop, "raised startup panel must separate from the canvas");
});
