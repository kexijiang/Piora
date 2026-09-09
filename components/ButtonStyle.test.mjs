import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all project buttons inherit the Codex-style hover, press, focus, and disabled baseline", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /button:not\(:disabled\):hover[\s\S]*background-image:[\s\S]*color-mix\(in srgb, var\(--text\) 6%/);
  assert.match(css, /button:not\(:disabled\):active[\s\S]*transform:\s*scale\(0\.98\)/);
  assert.match(css, /button:focus-visible[\s\S]*outline:/);
  assert.match(css, /button:disabled[\s\S]*cursor:\s*not-allowed/);
});

test("remote token revocation uses a filled danger button", async () => {
  const component = await readFile(new URL("./RemoteControlSettings.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(component, /<button[^>]*className="ui-button"[^>]*data-variant="danger"[^>]*onClick=\{\(\) => void revoke\(token\.id\)\}/);
  assert.match(css, /\.ui-button\[data-variant="danger"\]\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--status-failed\) 80%, black\);[^}]*color:\s*#fff/);
  assert.match(css, /\.ui-button\[data-variant="danger"\]:hover:not\(:disabled\)/);
});

test("remote token history is collapsed by default and permanent deletion needs confirmation", async () => {
  const component = await readFile(new URL("./RemoteControlSettings.tsx", import.meta.url), "utf8");
  assert.match(component, /const activeTokens = tokens\.filter\(\(token\) => token\.active\)/);
  assert.match(component, /const inactiveTokens = tokens\.filter\(\(token\) => !token\.active\)/);
  assert.match(component, /<details[^>]*>[\s\S]*remote\.revokedRecords[\s\S]*inactiveTokens\.map\(renderToken\)[\s\S]*<\/details>/);
  assert.doesNotMatch(component, /<details[^>]*\bopen\b/);
  assert.match(component, /deleteConfirmationId === token\.id/);
  assert.match(component, /remote\.deleteConfirm/);
  assert.match(component, /mutateToken\(token\.id, true\)/);
});


test("remote token creation uses the theme accent without changing neutral primary buttons", async () => {
  const component = await readFile(new URL("./RemoteControlSettings.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(component, /<button[^>]*data-variant="accent"[^\n]*remote\.create/);
  assert.match(css, /\.ui-button\[data-variant="accent"\]\s*\{[^}]*background: var\(--accent\);[^}]*color: var\(--bg\)/);
  assert.match(css, /\.ui-button\[data-variant="accent"\]:hover:not\(:disabled\)\s*\{[^}]*background: var\(--accent-hover\)/);
  assert.match(css, /\.ui-button\[data-variant="primary"\]\s*\{[^}]*background: var\(--btn-primary-bg\)/);
});
