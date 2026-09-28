"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ManualLease = { token: string; serial: string; expiresAt: string };
type Holder = { owner: { kind: "agent" | "manual"; id: string } };

async function manualRequest(action: string, input: Record<string, unknown>) {
  const response = await fetch("/api/harmony/manual", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }), keepalive: action === "release",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? data.error ?? `HTTP ${response.status}`);
  return data as { lease: ManualLease };
}

function releaseToken(token: string) {
  void manualRequest("release", { leaseToken: token }).catch(() => undefined);
}

/** Acquire only for an intentional input; simply displaying a phone never claims it. */
export function useHarmonyManualControl({ active, serial, generation, online, holder, chinese }: {
  active: boolean; serial: string; generation?: number; online: boolean; holder?: Holder; chinese: boolean;
}) {
  const [ownerId, setOwnerId] = useState("");
  const [lease, setLease] = useState<ManualLease | null>(null);
  const [revision, setRevision] = useState(0);
  const currentLease = useRef<ManualLease | null>(null);
  const epoch = useRef(0);
  const pending = useRef<Promise<string> | null>(null);
  const context = useRef<string | null>(null);
  const contextKey = `${active}:${online}:${serial}:${generation}`;

  useEffect(() => {
    const key = "piora-harmony-manual-owner-v1";
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(key); } catch { /* Optional persistence. */ }
    const id = stored && /^manual:[A-Za-z0-9-]{1,80}$/.test(stored) ? stored : `manual:${crypto.randomUUID()}`;
    setOwnerId(id);
    try { sessionStorage.setItem(key, id); } catch { /* In-memory ownership remains valid. */ }
  }, []);

  const clearControl = useCallback(() => {
    setRevision(++epoch.current);
    pending.current = null;
    const previous = currentLease.current;
    currentLease.current = null;
    setLease(null);
    if (previous) releaseToken(previous.token);
  }, []);

  useEffect(() => {
    // A late acquisition/renewal from a previous phone or hidden panel must not revive control.
    clearControl();
    context.current = contextKey;
    const hide = () => { context.current = null; clearControl(); };
    const show = () => { context.current = contextKey; };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      context.current = null;
      clearControl();
    };
  }, [contextKey, clearControl]);

  const blocked = Boolean(holder && holder.owner.id !== ownerId);
  useEffect(() => { if (blocked) clearControl(); }, [blocked, clearControl]);

  useEffect(() => {
    if (!lease || !active) return;
    const expectedEpoch = epoch.current;
    const timer = window.setInterval(() => {
      void manualRequest("renew", { leaseToken: lease.token }).then(({ lease: renewed }) => {
        if (epoch.current !== expectedEpoch || currentLease.current?.token !== lease.token) return;
        currentLease.current = renewed;
        setLease(renewed);
      }).catch(() => {
        if (epoch.current === expectedEpoch && currentLease.current?.token === lease.token) clearControl();
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [active, lease, clearControl]);

  const obtain = useCallback(async (takeover = false) => {
    if (context.current !== contextKey || epoch.current !== revision) throw new Error(chinese ? "设备状态已改变，请重新操作" : "Device state changed; try again");
    if (!active || !online || !serial || !ownerId) throw new Error(chinese ? "请先连接设备" : "Connect a device first");
    if (blocked && !takeover) throw new Error(chinese ? "设备正在由其他控制者操作，请先接管" : "Another controller is active; take over first");
    const current = currentLease.current;
    if (!takeover && current?.serial === serial && Date.parse(current.expiresAt) > Date.now()) return current.token;
    if (pending.current) return pending.current;
    const expectedEpoch = epoch.current;
    const request = manualRequest(takeover ? "takeover" : "acquire", { serial, ownerId, ...(takeover ? { confirmed: true } : {}) })
      .then(({ lease: acquired }) => {
        if (epoch.current !== expectedEpoch) {
          releaseToken(acquired.token);
          throw new Error(chinese ? "设备状态已改变，请重新操作" : "Device state changed; try again");
        }
        currentLease.current = acquired;
        setLease(acquired);
        return acquired.token;
      });
    pending.current = request;
    try { return await request; } finally { if (pending.current === request) pending.current = null; }
  }, [contextKey, revision, active, online, serial, ownerId, blocked, chinese]);

  return { lease, ownerId, clearControl, ensureControl: obtain,
    canControl: Boolean(active && online && ownerId && !blocked), blocked };
}
