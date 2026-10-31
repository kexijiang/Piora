import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import sharp from "sharp";

const jiti = createJiti(import.meta.url);
const { CHARACTER_THEMES, CHARACTER_THEME_GROUPS } = await jiti.import("./character-themes.ts");
const backgrounds = await jiti.import("./backgrounds.ts");
const themePreferences = await jiti.import("./theme-preferences.ts");
const { parsePreviousCharacterAppearance } = await jiti.import("./character-appearance.ts");
const { characterThemesZh, characterThemesEn } = await jiti.import("./i18n/messages/character-themes.ts");
const assetRoot = new URL("../public/themes/character-backgrounds/", import.meta.url);
const css = readFileSync(new URL("../app/character-themes.css", import.meta.url), "utf8");
const luminance = hex => {
  const [r,g,b] = hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return r*.2126+g*.7152+b*.0722;
};
const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);

test("ships 21 distinct character looks including both Doubao variants with bilingual names", () => {
  assert.equal(CHARACTER_THEMES.length,21);
  assert.equal(new Set(CHARACTER_THEMES.map(t=>t.id)).size,21);
  assert.equal(CHARACTER_THEME_GROUPS.length,12);
  assert.deepEqual(Object.fromEntries(CHARACTER_THEME_GROUPS.map(g=>[g.id,CHARACTER_THEMES.filter(t=>t.group===g.id).length])),{
    whale:3,gpt:3,claude:3,kitty:3,glm:1,ernie:1,qwen:1,kimi:1,seed:2,minimax:1,grok:1,gemini:1,
  });
  for(const look of CHARACTER_THEMES){
    const preset=backgrounds.getBackgroundPreset(look.id);
    assert.equal(preset.asset,look.asset);
    assert.equal(preset.appearance,look.isDark?'dark':'light');
    assert.equal(themePreferences.isDarkTheme(look.id),look.isDark);
    for(const messages of [characterThemesEn,characterThemesZh]){
      assert.ok(messages[`theme.${look.id}.name`]);assert.ok(messages[preset.nameKey]);
    }
  }
  assert.equal(backgrounds.BACKGROUND_PRESETS.length,58);
  assert.equal(new Set(backgrounds.BACKGROUND_PRESETS.map(t=>t.id)).size,58);
});

test("all character images decode, have bounded size, and retain source notices separately from original MIT artwork", async () => {
  const expected=CHARACTER_THEMES.map(t=>t.asset.split('/').at(-1)).sort();
  assert.deepEqual(readdirSync(assetRoot).filter(n=>n.endsWith('.webp')).sort(),expected);
  for(const file of expected){
    const bytes=readFileSync(new URL(file,assetRoot));
    assert.ok(bytes.length<1.5*1024*1024);
    const image=await sharp(bytes).metadata();
    assert.equal(image.format,'webp');assert.ok(image.width>=1600&&image.height>=900);
  }
  assert.match(readFileSync(new URL('NOTICE.md',assetRoot),'utf8'),/ZipZipPipe/);
  assert.match(readFileSync(new URL('NOTICE.md',assetRoot),'utf8'),/CC BY-NC-SA 4\.0/);
  assert.match(readFileSync(new URL('NOTICE.md',assetRoot),'utf8'),/Sanrio/);
  assert.equal(JSON.parse(readFileSync(new URL('provenance.json',assetRoot),'utf8')).artwork.length,21);
});

test("character text, dim labels, links and primary buttons meet opaque-surface contrast", () => {
  for(const look of CHARACTER_THEMES){
    const block=css.match(new RegExp(`html\\[data-theme="${look.id}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(block,look.id);
    const tokens=Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m=>[m[1],m[2]]));
    for(const foreground of ['text','text-muted','text-dim','accent'])for(const background of ['bg','bg-panel']){
      assert.ok(contrast(tokens[foreground],tokens[background])>=4.5,`${look.id} ${foreground}/${background}`);
    }
    assert.ok(contrast(tokens['btn-primary-fg'],tokens['btn-primary-bg'])>=4.5,look.id);
    assert.ok(contrast(tokens['btn-primary-fg'],tokens['btn-primary-bg-hover'])>=4.5,`${look.id} hover`);
  }
});

test("every character background prepaints after restart and rejects unbundled roots", () => {
  for(const look of CHARACTER_THEMES){
    const props={};const root={dataset:{},style:{setProperty:(key,value)=>props[key]=value}};
    const preference={schemaVersion:1,source:'builtin',presetId:look.id,overlay:look.overlay,blur:0,sidebarOverlay:look.sidebarOverlay,filePanelOverlay:look.filePanelOverlay};
    vm.runInNewContext(backgrounds.BACKGROUND_INITIALIZATION_SCRIPT,{document:{documentElement:root},localStorage:{getItem:()=>JSON.stringify(preference)}});
    assert.equal(root.dataset.appBackgroundPreset,look.id);
    assert.equal(props['--app-background-image'],`url("${look.asset}")`);
    assert.equal(props['--app-background-overlay'],`${look.overlay}%`);
    assert.equal(props['--app-background-sidebar-overlay'],'36%');
    assert.equal(props['--app-background-file-panel-overlay'],'42%');
  }
  const raw=JSON.parse(readFileSync(new URL('manifest.json',assetRoot),'utf8'));
  for(const assetRoot of ['/themes/character-backgrounds/../../','/themes/arbitrary/','https://example.com/']){
    assert.throws(()=>backgrounds.parseBackgroundManifest({...raw,assetRoot}));
  }
});

test("legacy character default washes migrate before paint and hydration only once", () => {
  const { BACKGROUND_PREFERENCE_STORAGE_KEY: key, CHARACTER_OVERLAY_MIGRATION_KEY: marker } = backgrounds;
  for (const look of CHARACTER_THEMES) {
    const legacy = { schemaVersion: 1, source: 'builtin', presetId: look.id, overlay: look.overlay, blur: 0, sidebarOverlay: 82, filePanelOverlay: 86 };
    for (const firstPaint of [false, true]) {
      const saved = new Map([[key, JSON.stringify(legacy)]]);
      const storage = { getItem: name => saved.get(name) ?? null, setItem: (name, value) => saved.set(name, value) };
      const props = {};
      const root = { dataset: {}, style: { setProperty: (name, value) => props[name] = value } };
      if (firstPaint) {
        vm.runInNewContext(backgrounds.BACKGROUND_INITIALIZATION_SCRIPT, { document: { documentElement: root }, localStorage: storage });
        assert.equal(props['--app-background-sidebar-overlay'], '36%');
        assert.equal(props['--app-background-file-panel-overlay'], '42%');
      }
      assert.deepEqual(backgrounds.readStoredBackgroundPreference(storage), { ...legacy, sidebarOverlay: 36, filePanelOverlay: 42 });
      assert.equal(saved.get(marker), '1');
      assert.deepEqual(JSON.parse(saved.get(key)), { ...legacy, sidebarOverlay: 36, filePanelOverlay: 42 });
      // After migration, an explicit manual choice of the same old values wins.
      saved.set(key, JSON.stringify(legacy));
      vm.runInNewContext(backgrounds.BACKGROUND_INITIALIZATION_SCRIPT, { document: { documentElement: root }, localStorage: storage });
      assert.equal(props['--app-background-sidebar-overlay'], '82%');
      assert.deepEqual(backgrounds.readStoredBackgroundPreference(storage), legacy);
    }
  }
});

test("character overlay migration preserves custom tuning and works without storage writes", () => {
  const key = backgrounds.BACKGROUND_PREFERENCE_STORAGE_KEY;
  const legacy = { schemaVersion: 1, source: 'builtin', presetId: 'character-whale-tide', overlay: 64, blur: 0, sidebarOverlay: 82, filePanelOverlay: 86 };
  for (const changes of [{ overlay: 50 }, { blur: 1 }, { sidebarOverlay: 75 }, { filePanelOverlay: 60 }, { source: 'custom', presetId: null }, { presetId: 'aurora-glass' }]) {
    const custom = { ...legacy, ...changes };
    const saved = new Map([[key, JSON.stringify(custom)]]);
    const storage = { getItem: name => saved.get(name) ?? null, setItem: (name, value) => saved.set(name, value) };
    const root = { dataset: {}, style: { setProperty() {} } };
    vm.runInNewContext(backgrounds.BACKGROUND_INITIALIZATION_SCRIPT, { document: { documentElement: root }, localStorage: storage });
    assert.deepEqual(backgrounds.readStoredBackgroundPreference(storage), custom);
    assert.deepEqual(JSON.parse(saved.get(key)), custom);
  }
  const storage = { getItem: name => name === key ? JSON.stringify(legacy) : null, setItem() { throw new Error('storage unavailable'); } };
  const props = {};
  vm.runInNewContext(backgrounds.BACKGROUND_INITIALIZATION_SCRIPT, { document: { documentElement: { dataset: {}, style: { setProperty: (name, value) => props[name] = value } } }, localStorage: storage });
  assert.equal(props['--app-background-sidebar-overlay'], '36%');
  assert.equal(backgrounds.readStoredBackgroundPreference(storage).sidebarOverlay, 36);
});

test("saved previous appearance retains custom and built-in preferences without accepting malformed snapshots", () => {
  for(const source of ['none','builtin','custom']){
    const previous={theme:'ivory',background:{schemaVersion:1,source,presetId:source==='builtin'?'sage-paper':null,overlay:35,blur:2,sidebarOverlay:49,filePanelOverlay:67}};
    assert.deepEqual(parsePreviousCharacterAppearance(JSON.stringify(previous)),previous);
  }
  for(const value of [null,'bad','{}','{"theme":"unknown","background":{}}','{"theme":"light","background":{"source":"builtin","presetId":"missing"}}'])assert.equal(parsePreviousCharacterAppearance(value),null);
});
