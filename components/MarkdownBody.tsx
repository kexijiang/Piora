"use client";

import { lazy, Suspense, useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { parseAnsiLine } from "@/lib/ansi";
import { markdownRemarkPlugins, normalizeDisplayMath, normalizeTextHighlights } from "@/lib/markdown";
import { useMarkdownRehypePlugins } from "@/hooks/useMarkdownRehypePlugins";

export { preloadMarkdownMathRenderer, preloadMarkdownRawHtmlParser } from "@/hooks/useMarkdownRehypePlugins";

let markdownCodeToolsPromise: ReturnType<typeof importMarkdownCodeTools> | null = null;

function importMarkdownCodeTools() {
  return import("./MermaidBlock");
}

function loadMarkdownCodeTools() {
  markdownCodeToolsPromise ??= importMarkdownCodeTools();
  return markdownCodeToolsPromise;
}

const LazyMermaidBlock = lazy(() => loadMarkdownCodeTools().then((module) => ({ default: module.MermaidBlock })));
const LazyCodeBlock = lazy(() => loadMarkdownCodeTools().then((module) => ({ default: module.CodeBlock })));

function CodeBlockFallback({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function MermaidPreviewFallback() {
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
      </div>
      <div className="mermaid-block mermaid-block-loading" />
    </div>
  );
}

export interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeTextHighlights(normalizeDisplayMath(children)), [children]);
  const rehypePlugins = useMarkdownRehypePlugins(normalizedMarkdown);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    text({ children }) {
      const text = String(children);
      if (!text.includes("\x1b")) return <>{children}</>;

      return (
        <>
          {parseAnsiLine(text).map((segment, index) => (
            Object.keys(segment.style).length > 0
              ? <span key={`${text}-${index}`} style={segment.style}>{segment.text}</span>
              : <span key={`${text}-${index}`}>{segment.text}</span>
          ))}
        </>
      );
    },
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          const code = raw.replace(/\n$/, "");
          return (
            <Suspense fallback={<MermaidPreviewFallback />}>
              <LazyMermaidBlock code={code} isStreaming={isStreaming} defaultPreview />
            </Suspense>
          );
        }
        const code = raw.replace(/\n$/, "");
        return (
          <Suspense fallback={<CodeBlockFallback code={code} lang={lang} />}>
            <LazyCodeBlock code={code} lang={lang} />
          </Suspense>
        );
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
