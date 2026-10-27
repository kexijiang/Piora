"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createDiagramCache, fitDiagram, scopeDiagramSvg, type Diagram } from "@/lib/mermaid-preview";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import a11yOneLight from "react-syntax-highlighter/dist/esm/styles/prism/a11y-one-light";
import coldarkCold from "react-syntax-highlighter/dist/esm/styles/prism/coldark-cold";
import duotoneDark from "react-syntax-highlighter/dist/esm/styles/prism/duotone-dark";
import duotoneLight from "react-syntax-highlighter/dist/esm/styles/prism/duotone-light";
import dracula from "react-syntax-highlighter/dist/esm/styles/prism/dracula";
import gruvboxDark from "react-syntax-highlighter/dist/esm/styles/prism/gruvbox-dark";
import materialDark from "react-syntax-highlighter/dist/esm/styles/prism/material-dark";
import nightOwl from "react-syntax-highlighter/dist/esm/styles/prism/night-owl";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import solarizedDarkAtom from "react-syntax-highlighter/dist/esm/styles/prism/solarized-dark-atom";
import solarizedlight from "react-syntax-highlighter/dist/esm/styles/prism/solarizedlight";
import synthwave84 from "react-syntax-highlighter/dist/esm/styles/prism/synthwave84";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";
import { LazySyntaxHighlighter as SyntaxHighlighter } from "./LazySyntaxHighlighter";

function codeThemeWithoutBackground(theme: Record<string, CSSProperties>): Record<string, CSSProperties> {
  const pre = { ...theme['pre[class*="language-"]'] };
  // The app owns the code surface. Prism's themes mix background shorthands
  // and longhands, which otherwise conflict when switching light/dark mode.
  delete pre.background;
  delete pre.backgroundColor;
  return { ...theme, 'pre[class*="language-"]': pre };
}

const LIGHT_CODE_THEME = codeThemeWithoutBackground(vs);
const DARK_CODE_THEME = codeThemeWithoutBackground(vscDarkPlus);

const THEME_CODE_LIGHT: Record<Theme, Record<string, CSSProperties>> = {
  light: LIGHT_CODE_THEME,
  starlight: codeThemeWithoutBackground(oneLight),
  ivory: codeThemeWithoutBackground(a11yOneLight),
  doodle: codeThemeWithoutBackground(a11yOneLight),
  fortune: codeThemeWithoutBackground(coldarkCold),
  nordic: codeThemeWithoutBackground(oneLight),
  sakura: codeThemeWithoutBackground(solarizedlight),
  kitty: codeThemeWithoutBackground(duotoneLight),
  "cloud-bear": codeThemeWithoutBackground(solarizedlight),
  "anime-sky": codeThemeWithoutBackground(a11yOneLight),
  "anime-sakura": codeThemeWithoutBackground(duotoneLight),
  "anime-magic": codeThemeWithoutBackground(duotoneLight),
  "anime-neon": codeThemeWithoutBackground(a11yOneLight),
  "anime-star": codeThemeWithoutBackground(oneLight),
  midnight: codeThemeWithoutBackground(oneDark),
  forest: codeThemeWithoutBackground(dracula),
  cyber: codeThemeWithoutBackground(solarizedlight),
  ember: codeThemeWithoutBackground(gruvboxDark),
  dream: codeThemeWithoutBackground(duotoneDark),
  dark: LIGHT_CODE_THEME,
};

const THEME_CODE_DARK: Record<Theme, Record<string, CSSProperties>> = {
  light: DARK_CODE_THEME,
  starlight: DARK_CODE_THEME,
  ivory: DARK_CODE_THEME,
  doodle: DARK_CODE_THEME,
  fortune: DARK_CODE_THEME,
  nordic: DARK_CODE_THEME,
  sakura: DARK_CODE_THEME,
  kitty: DARK_CODE_THEME,
  "cloud-bear": DARK_CODE_THEME,
  "anime-sky": DARK_CODE_THEME,
  "anime-sakura": DARK_CODE_THEME,
  "anime-magic": codeThemeWithoutBackground(nightOwl),
  "anime-neon": codeThemeWithoutBackground(synthwave84),
  "anime-star": codeThemeWithoutBackground(solarizedDarkAtom),
  midnight: codeThemeWithoutBackground(vscDarkPlus),
  forest: codeThemeWithoutBackground(duotoneDark),
  cyber: codeThemeWithoutBackground(materialDark),
  ember: codeThemeWithoutBackground(dracula),
  dream: codeThemeWithoutBackground(oneDark),
  dark: DARK_CODE_THEME,
};

function codeThemeForTheme(theme: Theme, isDark: boolean): Record<string, CSSProperties> {
  return (isDark ? THEME_CODE_DARK : THEME_CODE_LIGHT)[theme];
}

interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;
const PNG_MAX_EDGE = 4096;
const PNG_SCALE = 2;

type RenderState =
  | { key: string; status: "error" }
  | { key: string; status: "ready"; diagram: Diagram };

type ImageActionState = "idle" | "pending" | "success" | "error";

function readSvgLength(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value.trim())) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readSvgSize(svg: Element): { height: number; width: number } {
  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : null;
  const viewBoxHeight = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : null;
  const width = viewBoxWidth ?? readSvgLength(svg.getAttribute("width")) ?? 1200;
  const height = viewBoxHeight ?? readSvgLength(svg.getAttribute("height")) ?? Math.max(400, width * 0.625);
  return { height, width };
}

// Mermaid's configuration is global. Serialize initialize/parse/render together
// so concurrent light/dark requests cannot contaminate each other's results.
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;
const diagramCache = createDiagramCache((key) => {
  const request = renderQueue.catch(() => {}).then(async () => {
    const split = key.indexOf("\n");
    const theme = key.slice(0, split);
    const code = key.slice(split + 1);
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ htmlLabels: false, startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    if (!parsed) throw new Error("Invalid Mermaid diagram");
    // Mermaid otherwise appends temporary layout SVGs to body, changing page
    // geometry while rendering. Hidden (not display:none) keeps text measurable.
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none;";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(`mermaid-render-${++renderSequence}`, code, host);
      // Some renderers finalize node transforms after calculating their viewBox.
      // Measure the completed SVG. Repair an undersized viewBox from its actual
      // content; otherwise preserve the renderer's intentional framing.
      host.innerHTML = svg;
      const element = host.querySelector("svg")!;
      const box = element.getBBox();
      const view = element.viewBox.baseVal;
      if (view.width > 0 && view.height > 0 && box.width > 0 && box.height > 0
        && (box.x < view.x || box.y < view.y || box.x + box.width > view.x + view.width || box.y + box.height > view.y + view.height)) {
        const x = box.x - 8;
        const y = box.y - 8;
        const width = box.width + 16;
        const height = box.height + 16;
        element.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
        element.style.maxWidth = `${width}px`;
      }
      return { svg: element.outerHTML, ...readSvgSize(element) };
    } finally {
      host.remove();
    }
  });
  // The queue only retains completion, never an oversized result outside the
  // bounded cache after its last consumer unmounts.
  renderQueue = request.then(() => {}, () => {});
  return request;
});

function resolveMermaidExportBackground(fallback: string): string {
  const probe = document.createElement("span");
  probe.style.cssText = "position:fixed;inset:auto;opacity:0;pointer-events:none;background:color-mix(in srgb, var(--bg) 92%, var(--bg-panel));";
  document.body.appendChild(probe);
  const background = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return background && background !== "rgba(0, 0, 0, 0)" ? background : fallback;
}

async function renderMermaidPng(svgMarkup: string, background: string): Promise<Blob> {
  const parsed = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("Invalid SVG");
  const { height, width } = readSvgSize(svg);
  const scale = Math.min(PNG_SCALE, PNG_MAX_EDGE / width, PNG_MAX_EDGE / height);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const source = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" });
  const sourceUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to load Mermaid SVG"));
      image.src = sourceUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = background;
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.drawImage(image, 0, 0, outputWidth, outputHeight);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to create PNG")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function useTransientImageAction(action: () => Promise<void>) {
  const [state, setState] = useState<ImageActionState>("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const run = async () => {
    if (state === "pending") return;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    setState("pending");
    try {
      await action();
      setState("success");
    } catch {
      setState("error");
    }
    resetTimerRef.current = window.setTimeout(() => setState("idle"), 1800);
  };

  return { run, state };
}

function MermaidImageActions({ svg, variant }: { svg?: string; variant: "header" | "toolbar" }) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const background = () => resolveMermaidExportBackground(isDark ? "#18181b" : "#ffffff");
  const copyAction = useTransientImageAction(async () => {
    if (!svg || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image clipboard is unavailable");
    const png = renderMermaidPng(svg, background());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  const exportAction = useTransientImageAction(async () => {
    if (!svg) throw new Error("Mermaid preview is unavailable");
    const png = await renderMermaidPng(svg, background());
    const url = URL.createObjectURL(png);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = "mermaid-diagram.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  const labelFor = (kind: "copy" | "export", state: ImageActionState) => {
    if (state === "pending") return t("i18n.creatingMermaidImage");
    if (state === "error") return t("i18n.mermaidImageActionFailed");
    if (state === "success") return t(kind === "copy" ? "i18n.copiedMermaidImage" : "i18n.exportedMermaidPng");
    return t(kind === "copy" ? "i18n.copyMermaidImage" : "i18n.exportMermaidPng");
  };
  const copyLabel = labelFor("copy", copyAction.state);
  const exportLabel = labelFor("export", exportAction.state);
  const iconFor = (fallback: "copy" | "download", state: ImageActionState) => state === "success" ? "check" : state === "error" ? "alert" : fallback;
  const buttonClass = variant === "toolbar" ? "mermaid-zoom-icon-button mermaid-image-action" : "markdown-code-action mermaid-image-action";

  return (
    <>
      <button
        type="button"
        className={buttonClass}
        data-state={copyAction.state}
        disabled={!svg || copyAction.state === "pending"}
        onClick={() => void copyAction.run()}
        title={copyLabel}
        aria-label={copyLabel}
      >
        {variant === "toolbar" ? <AliIcon name={iconFor("copy", copyAction.state)} size={13} /> : copyLabel}
      </button>
      <button
        type="button"
        className={buttonClass}
        data-state={exportAction.state}
        disabled={!svg || exportAction.state === "pending"}
        onClick={() => void exportAction.run()}
        title={exportLabel}
        aria-label={exportLabel}
      >
        {variant === "toolbar" ? <AliIcon name={iconFor("download", exportAction.state)} size={13} /> : exportLabel}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {[copyAction.state === "success" || copyAction.state === "error" ? copyLabel : "", exportAction.state === "success" || exportAction.state === "error" ? exportLabel : ""].filter(Boolean).join(" · ")}
      </span>
    </>
  );
}

export function MermaidBlock({ code, isStreaming, defaultPreview = true }: MermaidBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;
  const previewVisible = showPreview && !isStreaming;
  // Read a completed result during render, before virtual rows measure height.
  const diagram = renderState?.key === currentKey && renderState.status === "ready" ? renderState.diagram : diagramCache.peek(currentKey);
  const readySvg = useMemo(() => diagram ? scopeDiagramSvg(diagram.svg, `inline-${instanceId}`) : undefined, [diagram, instanceId]);
  const knownSize = diagram ?? diagramCache.peek(`${isDark ? "light" : "dark"}\n${code}`);

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    diagramCache.load(currentKey).then(diagram => {
      if (!cancelled) setRenderState({ key: currentKey, status: "ready", diagram });
    }).catch(() => {
      if (!cancelled) setRenderState({ key: currentKey, status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, previewVisible]);

  const previewButton = (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : (previewVisible ? t("i18n.showMermaidSource") : t("i18n.previewMermaid"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  );

  if (!previewVisible) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} />;
  }

  const body = renderState?.key === currentKey && renderState.status === "error" ? (
      <div className="mermaid-block mermaid-block-error">{t("i18n.invalidMermaid")}</div>
    ) : !diagram || !readySvg ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("i18n.renderingMermaid")}>
        {knownSize && <div style={{ width: `min(100%, ${knownSize.width}px)`, aspectRatio: `${knownSize.width} / ${knownSize.height}` }} />}
      </div>
    ) : (
      <MermaidPreview key={currentKey} diagram={diagram} svg={readySvg} />
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        <div className="markdown-code-actions mermaid-preview-actions">
          {previewButton}
          <MermaidImageActions svg={readySvg} variant="header" />
        </div>
      </div>
      {body}
    </div>
  );
}

// The key and conditional mount tie viewer state to this exact preview. Returning
// to old code/theme or ending streaming must never resurrect a previously open dialog.
function MermaidPreview({ diagram, svg }: { diagram: Diagram; svg: string }) {
  const { t } = useI18n();
  const [zoomOpen, setZoomOpen] = useState(false);
  return <>
    <button
      type="button"
      className="mermaid-block mermaid-preview-button"
      title={t("i18n.openMermaidViewer")}
      aria-label={t("i18n.openMermaidViewer")}
      onClick={() => setZoomOpen(true)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
    {zoomOpen && <MermaidZoomDialog diagram={diagram} onClose={() => setZoomOpen(false)} />}
  </>;
}

function MermaidZoomDialog({ diagram, onClose }: { diagram: Diagram; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svg = useMemo(() => scopeDiagramSvg(diagram.svg, `dialog-${instanceId}`), [diagram, instanceId]);
  const [fit, setFit] = useState(1);
  // null follows the viewport; a user zoom is an absolute SVG scale, so a
  // resize cannot multiply it beyond the limit or unexpectedly enlarge it.
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const zoom = manualZoom ?? fit;
  const minimumZoom = Math.min(ZOOM_MIN, fit);
  const hasDesktopChrome = typeof window !== "undefined" && Boolean(window.piDesktop);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const opener = document.activeElement;
    dialog.showModal();
    const viewport = viewportRef.current!;
    const resize = () => {
      const style = getComputedStyle(viewport);
      setFit(fitDiagram(diagram, {
        width: Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
      }));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);

    return () => {
      observer.disconnect();
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [diagram]);

  const resetZoom = () => {
    setManualZoom(null);
    viewportRef.current?.scrollTo(0, 0);
  };

  return (
    <dialog
      ref={dialogRef}
      className="mermaid-zoom-dialog"
      style={{ "--diagram-width": `${Math.max(360, diagram.width + 48)}px`, "--diagram-height": `${Math.max(220, diagram.height + 104)}px` } as CSSProperties}
      data-desktop-chrome={hasDesktopChrome ? "true" : undefined}
      aria-label={t("i18n.mermaidViewer")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mermaid-zoom-layout">
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-title">{t("i18n.mermaidDiagram")}</span>
          <div className="mermaid-zoom-actions">
            <div className="mermaid-zoom-stepper">
              <button
                type="button"
                onClick={() => setManualZoom((value) => Math.max(minimumZoom, (value ?? fit) - ZOOM_STEP))}
                disabled={zoom <= minimumZoom}
                title={t("i18n.zoomOut")}
                aria-label={t("i18n.zoomOut")}
              >
                <AliIcon name="minus" size={13} />
              </button>
              <span className="mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setManualZoom((value) => Math.min(ZOOM_MAX, (value ?? fit) + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title={t("i18n.zoomIn")}
                aria-label={t("i18n.zoomIn")}
              >
                <AliIcon name="plus" size={13} />
              </button>
            </div>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={resetZoom}
              title={t("i18n.fitToView")}
              aria-label={t("i18n.fitToView")}
            >
              <AliIcon name="fullscreen" size={13} />
            </button>
            <MermaidImageActions svg={svg} variant="toolbar" />
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={onClose}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
            >
              <AliIcon name="close" size={13} />
            </button>
          </div>
        </div>
        <div
          ref={viewportRef}
          className="mermaid-zoom-viewport"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const viewport = event.currentTarget;
            drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
            viewport.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
            event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
          }}
          onPointerUp={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}
        >
          <div
            className="mermaid-zoom-canvas"
            style={{ width: diagram.width * zoom, height: diagram.height * zoom }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </dialog>
  );
}

interface CodeBlockProps {
  code: string;
  lang: string;
  headerAction?: ReactNode;
}

/**
 * Syntax-highlighted code block with copy button.
 * Used as the "source" view for mermaid blocks and for all non-mermaid code fences.
 */
export function CodeBlock({ code, lang, headerAction }: CodeBlockProps) {
  const { isDark, theme } = useTheme();
  const codeTheme = codeThemeForTheme(theme, isDark);
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            onClick={copy}
            className="markdown-code-action"
          >
            {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        language={lang || "text"}
        style={codeTheme}
        showLineNumbers
        lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
        customStyle={{
          margin: 0,
          padding: "11px 13px",
          fontSize: "var(--text-sm)",
          lineHeight: 1.62,
          fontFamily: "var(--font-code-family)",
          fontWeight: "var(--ui-font-weight)",
          borderRadius: 0,
          backgroundColor: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-code-family)", fontSize: "inherit", fontWeight: "inherit" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
