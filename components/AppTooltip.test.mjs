import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tooltip = await readFile(new URL("./AppTooltip.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mounts one global theme-aware tooltip layer", () => {
  assert.match(layout, /import \{ AppTooltip \} from "@\/components\/AppTooltip"/);
  assert.match(layout, /<AppTooltip \/>/);
  assert.match(styles, /\.app-tooltip \{[\s\S]*?position: fixed;[\s\S]*?var\(--surface-raised\)/);
  assert.doesNotMatch(tooltip, /if \(!content\) return null/);
});

test("keeps the tooltip out of the body flex layout before stylesheets load", () => {
  assert.match(tooltip, /const style: TooltipCssProperties = \{[\s\S]*?position: "fixed"/);
  assert.match(tooltip, /pointerEvents: "none"/);
});

test("delegates native title hover and focus without consuming iframe names", () => {
  assert.match(tooltip, /closest\("\[title\]:not\(iframe\)"\)/);
  assert.match(tooltip, /document\.addEventListener\("pointerover", onPointerOver, true\)/);
  assert.match(tooltip, /document\.addEventListener\("focusin", onFocusIn, true\)/);
  assert.match(tooltip, /element\.removeAttribute\("title"\)/);
  assert.match(tooltip, /element\.setAttribute\("title", active\.title\)/);
});

test("does not rewrite server-rendered title attributes before AppShell hydrates", () => {
  assert.match(appShell, /data-app-hydrated=\{appHydrated \? "" : undefined\}/);
  assert.match(tooltip, /element\.closest\("\.app-shell"\)/);
  assert.match(tooltip, /if \(!isHydrationReady\(element\)\) return/);
});

test("positions tooltips in the viewport instead of inside clipped controls", () => {
  assert.match(tooltip, /element\.getBoundingClientRect\(\)/);
  assert.match(tooltip, /window\.innerWidth - bounds\.width - VIEWPORT_GAP/);
  assert.match(tooltip, /placement: TooltipPlacement/);
});
