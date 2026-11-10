"use client";

import { lazy, memo, Suspense, useDeferredValue, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { createLocalFileLinkClickHandler } from "@/lib/file-link-click";
import { FILE_REFERENCE_HREF, formatFileReference, parseFileReference, remarkFileReferences } from "@/lib/file-references";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { parseAnsiLine } from "@/lib/ansi";
import { markdownRemarkPlugins, normalizeDisplayMath, normalizeTextHighlights } from "@/lib/markdown";
import { useMarkdownRehypePlugins } from "@/hooks/useMarkdownRehypePlugins";
import { rehypeAssistantEmphasis } from "@/lib/markdown-emphasis";
import { answerLinkTargetForClick, normalizeAnswerLink } from "@/lib/answer-links";
import { useAnswerLinks } from "./AnswerLinkProvider";

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

export const MarkdownBody = memo(function MarkdownBody(props: MarkdownBodyProps) {
  const deferredText = useDeferredValue(props.children);
  // Schedule streaming Markdown behind urgent typing/navigation. The final
  // message is always rendered immediately, including the final code/math block.
  return <MarkdownRenderer {...props}>{props.isStreaming ? deferredText : props.children}</MarkdownRenderer>;
});

const MarkdownRenderer = memo(function MarkdownRenderer({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeTextHighlights(normalizeDisplayMath(children)), [children]);
  const baseRehypePlugins = useMarkdownRehypePlugins(normalizedMarkdown);
  const isAssistantMessage = className?.split(/\s+/).includes("markdown-assistant-message") ?? false;
  const answerLinks = useAnswerLinks();
  const remarkPlugins = useMemo(() => onOpenFile && isAssistantMessage ? [...markdownRemarkPlugins, remarkFileReferences] : markdownRemarkPlugins, [onOpenFile, isAssistantMessage]);
  const rehypePlugins = useMemo(() => isAssistantMessage
    ? [...(baseRehypePlugins ?? []), rehypeAssistantEmphasis]
    : baseRehypePlugins, [baseRehypePlugins, isAssistantMessage]);
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
      let reference = null;
      if (href?.startsWith(FILE_REFERENCE_HREF)) {
        try { reference = parseFileReference(decodeURIComponent(href.slice(FILE_REFERENCE_HREF.length))); } catch { /* Invalid reference remains inert. */ }
      } else if (href && resolveLocalFileHref(href, cwd)) reference = parseFileReference(href);
      const resolved = reference ? resolveLocalFileHref(reference.path, cwd) : null;
      const filePath = onOpenFile ? reference ? formatFileReference({ ...reference, path: resolved ?? reference.path }) : resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        const webUrl = isAssistantMessage && answerLinks ? normalizeAnswerLink(href) : null;
        const handleWebLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
          if (!webUrl || !answerLinks || event.defaultPrevented || event.altKey || (event.button !== 0 && event.button !== 1)) return;
          event.preventDefault();
          if (answerLinkTargetForClick(answerLinks.target, event) === "builtin") answerLinks.openLink(webUrl);
          else window.open(webUrl, "_blank", "noopener,noreferrer");
        };
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer" onClick={handleWebLink} onAuxClick={handleWebLink}>
            {children}
          </a>
        );
      }

      const handleClick = createLocalFileLinkClickHandler(filePath, openFile);

      return (
        <a href={href} {...props} title={filePath} onClick={handleClick}>
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
  }), [cwd, isStreaming, onOpenFile, isAssistantMessage, answerLinks]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});
