"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HarmonyRequestError } from "@/lib/harmony/request-error";

type ManualLease = { token: string; serial: string; expiresAt: string };
type Holder = { owner: { kind: "agent" | "manual"; id: string } };

async function manualRequest(action: string, input: Record<string, unknown>) {
  const response = await fetch("/api/harmony/manual", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }), keepalive: action === "release",
  });
  const data = await response.json();
  if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
  return data as { lease: ManualLease };
}

function releaseToken(token: string) {
  void manualRequest("release", { leaseToken: token }).catch(() => undefined);
}

/** Acquire only for an explicit tool action; simply displaying a phone never claims it. */
export function useHarmonyManualControl({ active, serial, online, holder, chinese, controlStatus }: {
  active: boolean; serial: string; online: boolean; holder?: Holder; chinese: boolean;
  controlStatus?: "stopping" | "recovering";
}) {
  const [ownerId, setOwnerId] = useState("");
  const [lease, setLease] = useState<ManualLease | null>(null);
  const [revision, setRevision] = useState(0);
  const currentLease = useRef<ManualLease | null>(null);
  const preemptedLeaseToken = useRef<string | null>(null);
  const epoch = useRef(0);
  const pending = useRef<Promise<string> | null>(null);
  const context = useRef<string | null>(null);
  const contextKey = `${active}:${online}:${serial}`;

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
    preemptedLeaseToken.current = null;
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
  useEffect(() => { if (blocked && holder?.owner.kind !== "agent") clearControl(); }, [blocked, holder?.owner.kind, clearControl]);

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
    if (controlStatus) throw new HarmonyRequestError({ code: "DEVICE_BUSY", details: { state: controlStatus } }, 409);
    const current = currentLease.current;
    if (current?.serial === serial && Date.parse(current.expiresAt) > Date.now() && !takeover
      && (!blocked || preemptedLeaseToken.current === current.token)) return current.token;
    // An explicit user tool action may preempt an agent action.
    // Another manual window remains a conflict instead of being silently stopped.
    if (blocked && holder?.owner.kind !== "agent") throw new Error(chinese ? "设备正在由其他窗口操作" : "Another window is operating the device");
    takeover = takeover || Boolean(blocked && holder?.owner.kind === "agent");
    if (pending.current) return pending.current;
    const expectedEpoch = epoch.current;
    const request = manualRequest(takeover ? "takeover" : "acquire", { serial, ownerId, ...(takeover ? { confirmed: true } : {}) })
      .then(({ lease: acquired }) => {
        if (epoch.current !== expectedEpoch) {
          releaseToken(acquired.token);
          throw new Error(chinese ? "设备状态已改变，请重新操作" : "Device state changed; try again");
        }
        currentLease.current = acquired;
        preemptedLeaseToken.current = takeover ? acquired.token : null;
        setLease(acquired);
        return acquired.token;
      });
    pending.current = request;
    try { return await request; } finally { if (pending.current === request) pending.current = null; }
  }, [contextKey, revision, active, online, serial, ownerId, blocked, holder, chinese, controlStatus]);

  return { lease, ownerId, clearControl, ensureControl: obtain,
    canControl: Boolean(active && online && ownerId && (!blocked || holder?.owner.kind === "agent") && !controlStatus), blocked };
}
