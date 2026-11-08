"use client";
import { useCallback, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type WheelEvent } from "react";
import { useHarmonyManualControl } from "./useHarmonyManualControl";
import { harmonyJson } from "@/lib/harmony/client";
import { mirrorPoint, type MirrorPoint } from "@/lib/harmony/mirror/coordinates";
import type { MirrorFrame } from "./useHarmonyMirror";

export function useMirrorInput({ enabled, frame, chinese }: { enabled: boolean; frame: MirrorFrame | null; chinese: boolean }) {
  const serial = frame?.serial ?? "";
  const manual = useHarmonyManualControl({ active: enabled, serial, online: Boolean(frame), chinese });
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0), tail = useRef(Promise.resolve()), pending = useRef(0), stopped = useRef(false);
  const gesture = useRef<{ point: MirrorPoint; started: number; epoch: number; pointer: number } | null>(null);
  const wheelAt = useRef(0);
  const abort = useRef(new AbortController());
  const identity = `${enabled}:${serial}:${frame?.generation}:${frame?.width}:${frame?.height}`;
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const currentEpoch = ++epoch.current; stopped.current = false; gesture.current = null; setError(null);
    return () => { controller.abort(); epoch.current = currentEpoch + 1; gesture.current = null; stopped.current = true; };
  }, [identity]);

  const send = useCallback((body: Record<string, unknown>, coordinates = false) => {
    if (!enabled || !frame || !manual.canControl || stopped.current) return Promise.resolve(false);
    if (pending.current >= 4) { setError(chinese ? "请等待当前操作完成" : "Wait for the current input to finish"); return Promise.resolve(false); }
    const expected = epoch.current, expectedFrame = frame;
    const scopeSignal = abort.current.signal;
    pending.current++;
    const run = async () => {
      const current = () => expected === epoch.current && !stopped.current;
      // The device worker can spend 20 seconds establishing its first connection
      // and has a 45-second execution deadline. Include lease/geometry overhead,
      // and start this budget when the queued operation actually begins.
      const signal = AbortSignal.any([scopeSignal, AbortSignal.timeout(60000)]);
      try {
        if (!current()) return false;
        const [leaseToken, geometryResult] = await Promise.all([
          manual.ensureControl(),
          coordinates ? harmonyJson<{ geometry: { geometryId: string; frameWidth: number; frameHeight: number } }>(`/api/harmony/geometry?serial=${encodeURIComponent(serial)}&space=video`, undefined, signal) : Promise.resolve(undefined),
        ]);
        if (!current()) return false;
        let geometryId: string | undefined;
        if (coordinates) {
          const result = geometryResult!;
          if (!current()) return false;
          if (result.geometry.frameWidth !== expectedFrame.width || result.geometry.frameHeight !== expectedFrame.height) throw new Error(chinese ? "屏幕方向已变化，请重新操作" : "The screen orientation changed; try again");
          geometryId = result.geometry.geometryId;
        }
        if (!current()) return false;
        await harmonyJson("/api/harmony/action", { ...body, serial, leaseToken,
          ...(coordinates ? { geometryId, generation: expectedFrame.generation, coordinateSpace: "frame" } : {}) }, signal);
        if (current()) setError(null);
        return current();
      } catch (cause) {
        if (!current()) return false;
        // Never replay a queued gesture after an ambiguous input result.
        stopped.current = true; gesture.current = null;
        setError(cause instanceof Error ? cause.message : String(cause));
        manual.clearControl();
        return false;
      } finally { pending.current--; }
    };
    const task = tail.current.then(run, run);
    tail.current = task.then(() => undefined, () => undefined);
    return task;
  }, [enabled, frame, manual, serial, chinese]);

  const point = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => frame
    ? mirrorPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame) : undefined;
  return { error, send, canControl: enabled && manual.canControl,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (!enabled || !manual.canControl || event.button !== 0 || !event.isPrimary) return;
        const start = point(event); if (!start) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { point: start, started: performance.now(), epoch: epoch.current, pointer: event.pointerId };
      },
      onPointerCancel() { gesture.current = null; },
      onLostPointerCapture() { gesture.current = null; },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        const start = gesture.current; gesture.current = null;
        if (!start || start.epoch !== epoch.current || start.pointer !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const end = point(event); if (!end) return;
        const durationMs = Math.min(10000, Math.max(50, performance.now() - start.started));
        const distance = Math.hypot(end.x - start.point.x, end.y - start.point.y);
        if (distance < 8) send(durationMs >= 500 ? { action: "touch_hold", ...end, durationMs } : { action: "tap", ...end }, true);
        else send({ action: "drag", fromX: start.point.x, fromY: start.point.y, toX: end.x, toY: end.y, durationMs }, true);
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (!enabled || event.nativeEvent.isComposing || event.repeat) return;
        const keys: Record<string, string> = { Escape: "back", Enter: "enter", Home: "home", Backspace: "back" };
        if (keys[event.key]) { event.preventDefault(); send({ action: "press_key", key: keys[event.key] }); }
      },
      onWheel(event: WheelEvent<HTMLDivElement>) {
        if (!enabled || !frame || performance.now() - wheelAt.current < 180) return;
        const center = point(event); if (!center) return;
        wheelAt.current = performance.now();
        const distance = Math.min(frame.height * .25, 400) * Math.sign(event.deltaY);
        send({ action: "drag", fromX: center.x, fromY: center.y, toX: center.x,
          toY: Math.round(Math.min(frame.height - 1, Math.max(0, center.y - distance))), durationMs: 180 }, true);
      },
    },
  };
}
