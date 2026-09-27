"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Screenshots from "./vendor";
import enUS from "./vendor/en_US";
import { useI18n } from "@/hooks/useI18n";
import type { CapturePlan, CaptureRect } from "@/desktop/src/screenshot-geometry";
import type { ScreenshotFrame, ScreenshotOutputAction, ScreenshotOutputResult, ScreenshotWindowState, ScreenshotWindowUpdate } from "@/desktop/src/screenshot-types";
import styles from "./ScreenshotWorkspace.module.css";

interface ScreenshotBridge {
  state(): Promise<ScreenshotWindowState>;
  ready(): Promise<boolean>;
  begin(): Promise<boolean>;
  end(): Promise<boolean>;
  cancel(): Promise<boolean>;
  output(captureId: string, action: ScreenshotOutputAction, bytes: Uint8Array): Promise<ScreenshotOutputResult>;
  onUpdate(listener: (update: ScreenshotWindowUpdate) => void): () => void;
}

declare global {
  interface Window { piScreenshot?: ScreenshotBridge }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法加载屏幕图像"));
    image.src = url;
  });
}

async function composeDisplays(plan: CapturePlan, frames: ScreenshotFrame[]): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = plan.bounds.width;
  canvas.height = plan.bounds.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建截图画布");
  context.imageSmoothingEnabled = false;
  const images = await Promise.all(frames.map(async (frame) => [frame.id, await loadImage(frame.dataUrl)] as const));
  const imageById = new Map(images);
  for (const tile of plan.tiles) {
    const image = imageById.get(tile.displayId);
    if (!image) throw new Error("显示器图像缺失");
    const { source, destination } = tile;
    context.drawImage(image, source.x, source.y, source.width, source.height,
      destination.x, destination.y, destination.width, destination.height);
  }
  return canvas.toDataURL("image/png");
}

function selectionOnFrame(bounds: CaptureRect, frame: ScreenshotFrame): CaptureRect | null {
  const origin = frame.physicalBounds;
  const x = Math.max(bounds.x, origin.x);
  const y = Math.max(bounds.y, origin.y);
  const right = Math.min(bounds.x + bounds.width, origin.x + origin.width);
  const bottom = Math.min(bounds.y + bounds.height, origin.y + origin.height);
  if (right <= x || bottom <= y) return null;
  return {
    x: (x - origin.x) * frame.dipBounds.width / origin.width,
    y: (y - origin.y) * frame.dipBounds.height / origin.height,
    width: (right - x) * frame.dipBounds.width / origin.width,
    height: (bottom - y) * frame.dipBounds.height / origin.height,
  };
}

interface Editor { url: string; width: number; height: number; bounds: CaptureRect; attachEnabled: boolean; cross: boolean }

export default function ScreenshotWorkspace() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [state, setState] = useState<ScreenshotWindowState | null>(null);
  const [selection, setSelection] = useState<CaptureRect | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const currentDisplayId = useRef("");

  useEffect(() => {
    const bridge = window.piScreenshot;
    if (!bridge) return;
    let alive = true;
    const handleUpdate = (update: ScreenshotWindowUpdate) => {
      if (!alive) return;
      if (update.phase === "selection") { setSelection(update.bounds); return; }
      if (update.phase === "error") { setError(update.message); setBusy(false); return; }
      const current = update;
      const frame = update.frames.find((item) => item.id === currentDisplayId.current);
      if (!frame) { setError("截图显示器已断开"); return; }
      void (async () => {
        try {
          if (current.plan.crossesDisplays) {
            const url = await composeDisplays(current.plan, current.frames);
            if (!alive) return;
            const fit = Math.min(1, window.innerWidth / current.selection.width, window.innerHeight / current.selection.height);
            const width = Math.max(1, Math.floor(current.selection.width * fit));
            const height = Math.max(1, Math.floor(current.selection.height * fit));
            setEditor({ url, width, height, bounds: { x: 0, y: 0, width, height }, attachEnabled: Boolean(current.targetDraftKey), cross: true });
          } else {
            const bounds = selectionOnFrame(current.selection, frame);
            if (!bounds) throw new Error("截图选区不在当前显示器上");
            setEditor({ url: frame.dataUrl, width: frame.dipBounds.width, height: frame.dipBounds.height,
              bounds, attachEnabled: Boolean(current.targetDraftKey), cross: false });
          }
        } catch (cause) {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    };
    const off = bridge.onUpdate(handleUpdate);
    void bridge.state().then((initial) => {
      if (alive) {
        currentDisplayId.current = initial.displayId;
        setState(initial);
        if (initial.update) handleUpdate(initial.update);
      }
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (!state) return;
    let active = true;
    void loadImage(state.frame.dataUrl).then(() => {
      if (active) return window.piScreenshot?.ready();
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); void window.piScreenshot?.cancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const output = useCallback(async (action: ScreenshotOutputAction, blob: Blob) => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.piScreenshot?.output(state.captureId, action, bytes);
      if (!result) throw new Error("截图窗口连接已断开");
      if (result.status === "error") throw new Error(result.message);
      if (result.status === "pending") return;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [state, busy]);

  if (!state) return <div className={styles.loading}>{error || (zh ? "正在准备截图…" : "Preparing screenshot…")}</div>;
  if (editor) {
    return <main className={styles.editor}>
      <div className={editor.cross ? styles.crossScroll : styles.singleScroll}>
        <div>
          <Screenshots key={editor.url} url={editor.url} width={editor.width} height={editor.height}
            initialBounds={editor.bounds} attachEnabled={editor.attachEnabled} lang={zh ? undefined : enUS}
            onOk={(blob: Blob) => void output("copy", blob)}
            onSave={(blob: Blob) => void output("save", blob)}
            onAttach={(blob: Blob) => void output("attach", blob)}
            onCancel={() => void window.piScreenshot?.cancel()}
            onError={(cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))} />
        </div>
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {busy ? <div className={styles.busy}>{zh ? "正在处理截图…" : "Processing screenshot…"}</div> : null}
    </main>;
  }
  const frame = state.frame;
  const visible = selection ? selectionOnFrame(selection, frame) : null;
  const lensSize = 120;
  const magnification = 4;
  const lensX = pointer ? Math.min(frame.dipBounds.width - lensSize - 8, Math.max(8, pointer.x + 22)) : 0;
  const lensY = pointer ? Math.min(frame.dipBounds.height - lensSize - 8, Math.max(8, pointer.y + 22)) : 0;
  return <main className={styles.selector} onMouseMove={(event) => setPointer({ x: event.clientX, y: event.clientY })}
    onMouseLeave={() => setPointer(null)} onMouseDown={(event) => {
    if (event.button === 0) { setError(""); void window.piScreenshot?.begin(); }
  }} onMouseUp={(event) => { if (event.button === 0) void window.piScreenshot?.end(); }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className={styles.screenImage} src={frame.dataUrl} alt="" draggable={false} />
    <div className={styles.scrim} />
    {visible ? <div className={styles.selection} style={visible} /> : null}
    {selection ? <div className={styles.dimensions} style={{ left: Math.max(8, (visible?.x ?? 0) + (visible?.width ?? 0) - 95), top: Math.max(8, (visible?.y ?? 0) - 25) }}>{selection.width} × {selection.height} px</div> : null}
    {pointer ? <div className={styles.magnifier} style={{ left: lensX, top: lensY,
      backgroundImage: `url("${frame.dataUrl}")`,
      backgroundSize: `${frame.dipBounds.width * magnification}px ${frame.dipBounds.height * magnification}px`,
      backgroundPosition: `${lensSize / 2 - pointer.x * magnification}px ${lensSize / 2 - pointer.y * magnification}px`,
    }}>
      <span className={styles.crosshair} />
      <span className={styles.coordinates}>{Math.round(frame.physicalBounds.x + pointer.x * frame.physicalBounds.width / frame.dipBounds.width)}, {Math.round(frame.physicalBounds.y + pointer.y * frame.physicalBounds.height / frame.dipBounds.height)}</span>
    </div> : null}
    <div className={styles.hint}>{zh ? "拖动选择区域 · 单击截取整个屏幕 · Esc 取消" : "Drag to select · Click for full screen · Esc to cancel"}</div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
  </main>;
}
