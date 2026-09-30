import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";

test("reviewed DOMPurify preserves SVG content and neutralizes hook-detached event handlers", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: await readFile(new URL("../node_modules/dompurify/dist/purify.js", import.meta.url), "utf8") });
    const result = await page.evaluate(() => {
      const purifier = window.DOMPurify;
      const svg = purifier.sanitize('<svg><text>compatible diagram</text><script>unsafe()</script></svg>');
      const handlers = [];
      for (const hook of ["afterSanitizeElements", "afterSanitizeAttributes"]) {
        const root = document.createElement("div");
        root.innerHTML = '<section id="detach"><img onerror="unsafe()"></section>';
        const image = root.querySelector("img");
        document.body.appendChild(root);
        purifier.addHook(hook, node => { if (node.id === "detach") node.remove(); });
        purifier.sanitize(root, { IN_PLACE: true });
        handlers.push(image.getAttribute("onerror"));
        purifier.removeAllHooks();
        root.remove();
      }
      return { version: purifier.version, svg, handlers };
    });
    assert.equal(result.version, "3.4.16");
    assert.match(result.svg, /compatible diagram/);
    assert.doesNotMatch(result.svg, /<script/);
    assert.deepEqual(result.handlers, [null, null]);
  } finally { await browser.close(); }
});
