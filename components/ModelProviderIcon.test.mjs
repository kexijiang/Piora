import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ModelProviderIcon, resolveModelBrand } = await jiti.import("./ModelProviderIcon.tsx");

test("a cold provider glyph cannot suspend the surrounding application", () => {
  const html = renderToStaticMarkup(React.createElement(React.Suspense, { fallback: "WHOLE_APP_BLANK" },
    React.createElement("main", null, "APP_CONTENT", React.createElement(ModelProviderIcon, { provider: "qwen", modelId: "qwen3" }))));
  assert.match(html, /APP_CONTENT/);
  assert.doesNotMatch(html, /WHOLE_APP_BLANK/);
});

test("resolves the actual model family before a custom gateway provider", () => {
  assert.equal(resolveModelBrand("custom-gateway", "deepseek-v4-flash"), "deepseek");
  assert.equal(resolveModelBrand("openrouter", "anthropic/claude-sonnet-4.6"), "anthropic");
  assert.equal(resolveModelBrand("ollama", "qwen3:latest"), "qwen");
  assert.equal(resolveModelBrand("local", "llama-4-scout"), "meta");
});

test("falls back to provider branding and then the shared custom model icon", () => {
  assert.equal(resolveModelBrand("deepseek", "house-model"), "deepseek");
  assert.equal(resolveModelBrand("github-copilot", "house-model"), "github-copilot");
  assert.equal(resolveModelBrand("acme-gateway", "house-model"), "custom");

  const customHtml = renderToStaticMarkup(
    React.createElement(ModelProviderIcon, {
      provider: "acme-gateway",
      modelId: "house-model",
      size: 16,
    }),
  );
  assert.match(customHtml, /data-model-brand="custom"/);
  assert.match(customHtml, /aria-hidden="true"/);

  const deepSeekHtml = renderToStaticMarkup(
    React.createElement(ModelProviderIcon, {
      provider: "acme-gateway",
      modelId: "deepseek-v4-flash",
      size: 16,
    }),
  );
  assert.match(deepSeekHtml, /data-model-brand="deepseek"/);
});
