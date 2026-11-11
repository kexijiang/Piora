"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MirrorStatistics, MirrorWorkerCommand, MirrorWorkerEvent } from "@/lib/harmony/mirror/messages";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { useI18n } from "@/hooks/useI18n";

export interface MirrorFrame { serial: string; generation: number; width: number; height: number; revision: number }
export function useHarmonyMirror({ active, serial, generation, label }: { active: boolean; serial: string; generation?: number; label: string }) {
  const { locale } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const displayed = useRef<{ canvas: HTMLCanvasElement; frame: MirrorFrame } | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "live" | "recovering" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<HarmonyRequestError["controlStatus"]>();
  const [frame, setFrame] = useState<MirrorFrame | null>(null);
  const [statistics, setStatistics] = useState<MirrorStatistics | null>(null);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => {
    if (workerRef.current) workerRef.current.postMessage({ type: "reconnect" } satisfies MirrorWorkerCommand);
    else setRetry(value => value + 1);
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    const retained = displayed.current?.frame.serial === serial && displayed.current.frame.generation === generation ? displayed.current : null;
    if (!retained) { displayed.current?.canvas.remove(); displayed.current = null; }
    setFrame(retained?.frame ?? null); setStatistics(null); setError(null); setControlStatus(undefined);
    if (!active || !surface || !serial || generation === undefined) { setState("idle"); return; }
    // A fresh DOM canvas per ownership epoch is required: transferControlToOffscreen
    // is irreversible. This also makes React StrictMode's effect replay safe.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", label);
    canvas.style.cssText = `display:block;width:100%;height:100%;object-fit:contain;position:absolute;inset:0;opacity:${retained ? 0 : 1};`;
    surface.appendChild(canvas);
    let worker: Worker | undefined, disposed = false;
    setState("connecting");
    try {
      if (!canvas.transferControlToOffscreen) throw new Error("This runtime does not support worker video rendering");
      worker = new Worker(new URL("../lib/harmony/mirror/video.worker.ts", import.meta.url), { type: "module", name: "piora-harmony-mirror" });
      workerRef.current = worker;
      worker.onmessage = ({ data }: MessageEvent<MirrorWorkerEvent>) => {
        if (disposed || workerRef.current !== worker) return;
        if (data.type === "state") {
          const requestError = data.requestError ? new HarmonyRequestError(data.requestError, 503) : undefined;
          setState(data.state); setControlStatus(requestError?.controlStatus);
          setError(requestError ? requestError.messageFor(locale === "zh-CN") : data.error ?? null);
          // Fatal initialization failures need a new canvas and worker on retry.
          if (data.fatal) { worker?.terminate(); workerRef.current = null; }
        }
        else if (data.type === "frame") {
          const nextFrame = { serial, generation, width: data.width, height: data.height, revision: data.revision };
          if (displayed.current?.canvas !== canvas) displayed.current?.canvas.remove();
          canvas.style.opacity = "1"; displayed.current = { canvas, frame: nextFrame }; setFrame(nextFrame);
        }
        else if (data.type === "statistics") setStatistics(data.statistics);
      };
      worker.onerror = event => {
        if (disposed) return;
        setState("error"); setError(event.message || "The video worker stopped");
        worker?.terminate(); if (workerRef.current === worker) workerRef.current = null;
      };
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: "start", canvas: offscreen, serial, generation } satisfies MirrorWorkerCommand, [offscreen]);
    } catch (cause) {
      setState("error"); setError(cause instanceof Error ? cause.message : String(cause));
      worker?.terminate(); workerRef.current = null;
    }
    return () => {
      disposed = true;
      worker?.postMessage({ type: "stop" } satisfies MirrorWorkerCommand);
      // Allow abort/cancel to close the HTTP subscriber, then release the worker.
      if (worker) { const owned = worker; setTimeout(() => owned.terminate(), 100); }
      if (workerRef.current === worker) workerRef.current = null;
      // Keep the last painted frame through disconnection and worker replacement.
      // The next identity or first replacement frame removes it.
      if (displayed.current?.canvas !== canvas) canvas.remove();
    };
  }, [active, serial, generation, label, retry, locale]);

  return { surfaceRef, state, error, controlStatus, frame, statistics, refresh };
}
