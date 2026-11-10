import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
const jiti = createJiti(import.meta.url);
const { credentialFillScript } = await jiti.import("../desktop/src/credential-fill.ts");

test("credential fill checks the live form and origin, never submits or returns secret values", { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = "https://accounts.example.com/login";
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><form method="post"><input name="username" autocomplete="username"><input type="password" autocomplete="current-password"><button>Login</button></form><script>window.submits=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submits++}</script>' }));
  const fill = () => page.evaluate(credentialFillScript(url, "private-user", "private-password"));
  await page.goto(url);
  assert.equal(await page.evaluate(credentialFillScript(url, "", "", true)), true);
  assert.equal(await page.locator('input[type="password"]').inputValue(), "");
  assert.equal(await fill(), true);
  assert.equal(await page.locator('input[name="username"]').inputValue(), "private-user");
  assert.equal(await page.locator('input[type="password"]').inputValue(), "private-password");
  assert.equal(await page.evaluate(() => window.submits), 0);
  for (const change of [
    () => { document.querySelector("form").action = "https://evil.example/"; },
    () => { document.querySelector("form").method = "get"; },
    () => { document.querySelector('input[type="password"]').autocomplete = "new-password"; },
    () => { document.querySelector("form").insertAdjacentHTML("beforeend", '<input autocomplete="one-time-code">'); },
    () => { document.querySelector("button").textContent = "付款"; },
    () => { document.querySelector("form").insertAdjacentHTML("beforeend", '<input type="password">'); },
    () => { document.querySelector('input[name="username"]').style.display = "none"; },
  ]) {
    await page.goto(url); await page.evaluate(change);
    assert.equal(await fill(), false);
    assert.equal(await page.locator('input[type="password"]').first().inputValue(), "");
  }
  await page.goto("https://other.example.com/login");
  assert.equal(await fill(), false);
});
