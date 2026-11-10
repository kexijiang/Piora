"use client";
import { useCallback, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type WheelEvent } from "react";
import { useHarmonyManualControl } from "./useHarmonyManualControl";
import { harmonyJson } from "@/lib/harmony/client";
import { mirrorPoint } from "@/lib/harmony/mirror/coordinates";
import type { MirrorFrame } from "./useHarmonyMirror";
import { LiveTouch } from "@/lib/harmony/input/live-touch";

function beforeAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void request.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export function useMirrorInput({ enabled, frame, chinese }: { enabled: boolean; frame: MirrorFrame | null; chinese: boolean }) {
  const serial = frame?.serial ?? "";
  const manual = useHarmonyManualControl({ active: enabled, serial, online: Boolean(frame), chinese });
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const epoch = useRef(0), tail = useRef(Promise.resolve()), pending = useRef(0), stopped = useRef(false);
  const gesture = useRef<{ touch: LiveTouch; pointer: number } | null>(null);
  const wheelAt = useRef(0);
  const abort = useRef(new AbortController());
  type PreparedGeometry = { geometry: { geometryId: string; frameWidth: number; frameHeight: number } };
  const prepared = useRef<{ epoch: number; at: number; pending: boolean; request: Promise<PreparedGeometry> } | null>(null);
  const identity = `${enabled}:${serial}:${frame?.generation}:${frame?.width}:${frame?.height}`;
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const currentEpoch = ++epoch.current; stopped.current = false; gesture.current = null; prepared.current = null; setError(null); setPreparing(false);
    return () => {
      const active = gesture.current; gesture.current = null;
      controller.abort(); epoch.current = currentEpoch + 1; stopped.current = true;
      void active?.touch.up().catch(() => undefined);
    };
  }, [identity]);

  const prepareGeometry = () => {
    const cached = prepared.current;
    if (cached?.epoch === epoch.current && (cached.pending || performance.now() - cached.at < 300)) return cached.request;
    const request = harmonyJson<PreparedGeometry>(`/api/harmony/geometry?serial=${encodeURIComponent(serial)}&space=video`, undefined, abort.current.signal);
    const entry = { epoch: epoch.current, at: 0, pending: true, request }; prepared.current = entry;
    setPreparing(true);
    void request.then(() => {
      if (prepared.current === entry) { entry.pending = false; entry.at = performance.now(); setPreparing(false); }
    }, () => { if (prepared.current === entry) { prepared.current = null; setPreparing(false); } });
    return request;
  };

  const releasePointer = useCallback(() => {
    const active = gesture.current; gesture.current = null;
    if (!active) return;
    const expected = epoch.current;
    const releasing = active.touch.up();
    tail.current = releasing.catch(() => undefined);
    void releasing.catch(cause => { if (epoch.current === expected) { setError(cause instanceof Error ? cause.message : String(cause)); manual.clearControl(); } });
  }, [manual]);
  useEffect(() => {
    window.addEventListener("blur", releasePointer);
    window.addEventListener("pagehide", releasePointer);
    return () => { window.removeEventListener("blur", releasePointer); window.removeEventListener("pagehide", releasePointer); };
  }, [releasePointer]);

  const send = useCallback((body: Record<string, unknown>, coordinates = false) => {
    if (!enabled || !frame || !manual.canControl || preparing || stopped.current) return Promise.resolve(false);
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
  }, [enabled, frame, manual, preparing, serial, chinese]);

  const point = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => frame
    ? mirrorPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame) : undefined;
  return { error, preparing, send, canControl: enabled && manual.canControl && !preparing,
    handlers: {
      onPointerEnter() { if (enabled && frame && manual.canControl && !stopped.current) void prepareGeometry().catch(() => undefined); },
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (!enabled || !frame || !manual.canControl || stopped.current || gesture.current || event.button !== 0 || !event.isPrimary) return;
        const start = point(event); if (!start) return;
        // Warm-up may establish the read-only control transport. Do not claim a
        // lease or admit a gesture while it is pending: a mouse-up during cold
        // setup must never turn into a later click once the device is ready.
        if (!prepared.current || prepared.current.epoch !== epoch.current || prepared.current.pending) {
          event.preventDefault();
          const expected = epoch.current;
          void prepareGeometry().catch(cause => { if (epoch.current === expected) setError(cause instanceof Error ? cause.message : String(cause)); });
          return;
        }
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        const expected = epoch.current, expectedFrame = frame, previous = tail.current;
        // Bound setup as well as the physical hold: a late lease/geometry reply
        // must not inject an old click after the user has moved on.
        const startup = AbortSignal.any([abort.current.signal, AbortSignal.timeout(3000)]);
        let leaseToken: string | undefined, gestureId: string | undefined, releaseFailure: unknown;
        const fail = (cause: unknown) => {
          if (expected !== epoch.current) return;
          stopped.current = true; setError(cause instanceof Error ? cause.message : String(cause)); manual.clearControl();
        };
        const current = () => { if (expected !== epoch.current || stopped.current) throw new Error(chinese ? "设备状态已改变" : "Device state changed"); };
        const touch = new LiveTouch({ touch: async (phase, x, y) => {
          if (phase === "down") {
            await beforeAbort(previous, startup); current();
            const [token, { geometry }] = await beforeAbort(Promise.all([
              manual.ensureControl(),
              prepareGeometry(),
            ]), startup);
            startup.throwIfAborted();
            current(); leaseToken = token;
            if (geometry.frameWidth !== expectedFrame.width || geometry.frameHeight !== expectedFrame.height) throw new Error(chinese ? "屏幕方向已变化" : "Screen orientation changed");
            const result = await harmonyJson<{ gestureId: string }>("/api/harmony/pointer", { phase, serial, leaseToken, x, y, geometryId: geometry.geometryId, generation: expectedFrame.generation }, startup);
            gestureId = result.gestureId;
          } else if (gestureId && leaseToken) {
            if (phase !== "up") current();
            const response = await fetch("/api/harmony/pointer", { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phase, serial, leaseToken, gestureId, x, y }), keepalive: phase === "up", signal: AbortSignal.timeout(3000) });
            const result = await response.json();
            if (!response.ok) { releaseFailure = new Error(result.error?.message ?? result.error ?? "Pointer request failed"); throw releaseFailure; }
          }
        } }, { validate: current, maxHoldMs: 8000, recoverRelease: async () => { throw releaseFailure ?? new Error("Pointer release was not confirmed"); }, onError: fail });
        gesture.current = { touch, pointer: event.pointerId };
        void touch.down(start).catch(fail);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const active = gesture.current;
        if (!active) { if (enabled && frame && manual.canControl && !stopped.current) void prepareGeometry().catch(() => undefined); return; }
        if (active.pointer !== event.pointerId) return;
        const next = point(event); if (!next) return;
        void active.touch.move(next).catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)); releasePointer(); });
      },
      onPointerCancel() { releasePointer(); },
      onLostPointerCapture() { releasePointer(); },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        const active = gesture.current;
        if (!active || active.pointer !== event.pointerId) return;
        releasePointer();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
