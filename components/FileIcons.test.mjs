import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { resolveFileIcon, FolderIcon } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" } }).import("./FileIcons.tsx");

test("file associations distinguish language, framework, configuration, media and unknown files", () => {
  for (const [file, expected] of Object.entries({ "a.ts": "typescript", "App.TSX": "react_ts", "a.mjs": "javascript", "a.jsx": "react", "package.json": "nodejs", "readme.MD": "markdown", "a.css": "css", "a.py": "python", "a.yml": "yaml", "a.sql": "database", "image.svg": "image", "a.pdf": "pdf", ".gitignore": "git", ".env.local": "tune", "pnpm-lock.yaml": "lock", "vite.config.ts": "settings", "Dockerfile": "docker", "a.xml": "xml", "a.ps1": "console", "C:\\src\\main.rs": "rust" })) assert.equal(resolveFileIcon(file), expected, file);
  assert.equal(resolveFileIcon("unknown"), null); assert.equal(resolveFileIcon("unknown.xyz"), null);
  for (const [name, type] of Object.entries({ ordinary: "folder", SRC: "folder-src", node_modules: "folder-node", __tests__: "folder-test", ".git": "folder-git", config: "folder-config", dist: "folder-dist" })) {
    assert.match(renderToStaticMarkup(React.createElement(FolderIcon, { name })), new RegExp(`data-file-icon="${type}"`));
    assert.match(renderToStaticMarkup(React.createElement(FolderIcon, { name, open: true })), new RegExp(`data-file-icon="${type}-open"`));
  }
});

test("vendored sprite is a small immutable local subset with a complete distributed license", async () => {
  const sprite = await readFile(new URL("../public/file-icons/material.svg", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../public/file-icons/manifest.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(sprite).digest("hex"), manifest.spriteSha256);
  assert.equal(new Set(manifest.symbols).size, manifest.symbols.length);
  assert.ok(Buffer.byteLength(sprite) < 50_000);
  assert.ok(manifest.symbols.includes("folder-src-open") && manifest.symbols.includes("toml_light"));
  assert.doesNotMatch(sprite, /<script|<foreignObject|https?:\/\/(?!www\.w3\.org)/i);
  assert.match(await readFile(new URL("../public/file-icons/LICENSE.txt", import.meta.url), "utf8"), /Copyright.*Material Extensions/);
});
