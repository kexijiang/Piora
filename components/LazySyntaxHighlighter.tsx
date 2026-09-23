"use client";

import { useEffect, useState } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";

type LanguageDefinition = Parameters<typeof PrismLight.registerLanguage>[1];
type LanguageModule = { default: LanguageDefinition };
type LanguageLoader = () => Promise<LanguageModule>;

// Keep this list explicit: importing PrismAsyncLight pulls its several-hundred
// language dispatch table into the route chunk even though any one code block
// needs only one grammar. Each target below remains an independent lazy chunk.
const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  bash: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  batch: () => import("react-syntax-highlighter/dist/esm/languages/prism/batch"),
  c: () => import("react-syntax-highlighter/dist/esm/languages/prism/c"),
  cpp: () => import("react-syntax-highlighter/dist/esm/languages/prism/cpp"),
  csharp: () => import("react-syntax-highlighter/dist/esm/languages/prism/csharp"),
  css: () => import("react-syntax-highlighter/dist/esm/languages/prism/css"),
  dart: () => import("react-syntax-highlighter/dist/esm/languages/prism/dart"),
  diff: () => import("react-syntax-highlighter/dist/esm/languages/prism/diff"),
  docker: () => import("react-syntax-highlighter/dist/esm/languages/prism/docker"),
  go: () => import("react-syntax-highlighter/dist/esm/languages/prism/go"),
  graphql: () => import("react-syntax-highlighter/dist/esm/languages/prism/graphql"),
  hcl: () => import("react-syntax-highlighter/dist/esm/languages/prism/hcl"),
  ini: () => import("react-syntax-highlighter/dist/esm/languages/prism/ini"),
  java: () => import("react-syntax-highlighter/dist/esm/languages/prism/java"),
  javascript: () => import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
  json: () => import("react-syntax-highlighter/dist/esm/languages/prism/json"),
  json5: () => import("react-syntax-highlighter/dist/esm/languages/prism/json5"),
  jsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
  kotlin: () => import("react-syntax-highlighter/dist/esm/languages/prism/kotlin"),
  less: () => import("react-syntax-highlighter/dist/esm/languages/prism/less"),
  lua: () => import("react-syntax-highlighter/dist/esm/languages/prism/lua"),
  markdown: () => import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
  markup: () => import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  objectivec: () => import("react-syntax-highlighter/dist/esm/languages/prism/objectivec"),
  php: () => import("react-syntax-highlighter/dist/esm/languages/prism/php"),
  powershell: () => import("react-syntax-highlighter/dist/esm/languages/prism/powershell"),
  python: () => import("react-syntax-highlighter/dist/esm/languages/prism/python"),
  r: () => import("react-syntax-highlighter/dist/esm/languages/prism/r"),
  ruby: () => import("react-syntax-highlighter/dist/esm/languages/prism/ruby"),
  rust: () => import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
  sass: () => import("react-syntax-highlighter/dist/esm/languages/prism/sass"),
  scss: () => import("react-syntax-highlighter/dist/esm/languages/prism/scss"),
  sql: () => import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
  swift: () => import("react-syntax-highlighter/dist/esm/languages/prism/swift"),
  toml: () => import("react-syntax-highlighter/dist/esm/languages/prism/toml"),
  tsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
  typescript: () => import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
  yaml: () => import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  arkts: "typescript",
  cs: "csharp",
  dockerfile: "docker",
  ets: "typescript",
  hml: "markup",
  htm: "markup",
  html: "markup",
  js: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  node: "javascript",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  text: "text",
  plaintext: "text",
  txt: "text",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash",
};

const registeredLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<void>>();

function normalizeLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase() || "text";
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function ensureLanguage(language: string): Promise<void> | null {
  if (language === "text" || registeredLanguages.has(language)) return null;
  const existing = pendingLanguages.get(language);
  if (existing) return existing;
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return null;

  const pending = loader()
    .then((module) => {
      PrismLight.registerLanguage(language, module.default);
      registeredLanguages.add(language);
    })
    .finally(() => {
      if (pendingLanguages.get(language) === pending) pendingLanguages.delete(language);
    });
  pendingLanguages.set(language, pending);
  return pending;
}

export function LazySyntaxHighlighter({ language, ...props }: SyntaxHighlighterProps) {
  const normalizedLanguage = normalizeLanguage(language);
  const [, setRegistrationVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const pending = ensureLanguage(normalizedLanguage);
    if (pending) {
      void pending.then(() => {
        if (active) setRegistrationVersion((version) => version + 1);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [normalizedLanguage]);

  const highlightedLanguage = registeredLanguages.has(normalizedLanguage) ? normalizedLanguage : "text";
  return <PrismLight {...props} language={highlightedLanguage} />;
}
