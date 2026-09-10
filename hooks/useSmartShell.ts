"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellEvent, ShellInputMode, ShellReference, ShellSession, ShellSnapshot, ShellTimelinePage } from "@/lib/shell/types";
import { shellRequest, applyShellEvent, mergeShellTimeline } from "@/lib/shell/client";
import { confirmShellSubmission, pendingShellSubmissions, saveShellSubmission, type ShellSubmission } from "@/lib/shell/recovery";

export function useSmartShell(cwd: string) {
  const [inventory, setInventory] = useState<{ cwd: string; sessions: ShellSession[] }>({ cwd, sessions: [] });
  const sessions = inventory.cwd === cwd ? inventory.sessions : [];
  const [selection, setSelection] = useState<{ cwd: string; id: string | null }>({ cwd, id: null });
  const activeId = selection.cwd === cwd ? selection.id : null;
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<ShellSubmission[]>([]);
  const [archive, setArchive] = useState<(ShellTimelinePage & { terminalId: string; loading: boolean; failed: boolean }) | null>(null);
  const archived = useRef(archive); archived.current = archive;
  const archiveRequest = useRef<AbortController | null>(null);
  const current = useRef<ShellSnapshot | null>(null);
  const scope = useRef(cwd); scope.current = cwd;
  const active = useRef(activeId); active.current = activeId;
  const attempts = useRef(new Map<string, ShellSubmission>());
  const sending = useRef(new Map<string, Promise<"accepted" | "ambiguous" | "failed">>());
  const confirmed = useRef(new Set<string>());
  const subscribers = useRef(new Set<(event: ShellEvent) => void>());
  const inventoryRequest = useRef(0);
  const subscribe = useCallback((listener: (event: ShellEvent) => void) => {
    subscribers.current.add(listener);
    const snapshot = current.current;
    if (snapshot?.session.id === active.current) listener({ type: "snapshot", snapshot, terminalId: snapshot.session.id, generation: snapshot.session.generation, sequence: snapshot.sequence });
    return () => { subscribers.current.delete(listener); };
  }, []);
  const refreshSessions = useCallback(async () => {
    const request = ++inventoryRequest.current;
    const result = await shellRequest<{ sessions: ShellSession[] }>(`sessions?cwd=${encodeURIComponent(cwd)}`);
    if (scope.current === cwd && request === inventoryRequest.current) setInventory({ cwd, sessions: result.sessions });
    return result.sessions;
  }, [cwd]);
  const select = useCallback((id: string) => {
    setError(""); setConnected(false);
    active.current = id; setSelection({ cwd, id });
    try { localStorage.setItem(`piora-shell-active:${cwd}`, id); } catch { /* Selection is also recoverable from the session list. */ }
  }, [cwd]);
  const create = useCallback(async () => {
    try {
      const created = await shellRequest<ShellSnapshot>("sessions", { cwd });
      if (scope.current !== cwd) return;
      await refreshSessions(); select(created.session.id);
    } catch (cause) { setError(String(cause)); }
  }, [cwd, refreshSessions, select]);
  useEffect(() => {
    let disposed = false;
    void refreshSessions().then(async list => {
      if (disposed) return;
      let selected: string | null = null;
      try { selected = localStorage.getItem(`piora-shell-active:${cwd}`); } catch { /* Optional preference. */ }
      if (list.length) select(list.find(item => item.id === selected)?.id || list[0].id);
      else {
        const created = await shellRequest<ShellSnapshot>("sessions", { cwd, ensure: true });
        if (!disposed) { setInventory({ cwd, sessions: [created.session] }); select(created.session.id); }
      }
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [cwd, refreshSessions, select]);
  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController(); let disposed = false, sseConnected = false, reconciling = false;
    let lastInventory = 0;
    current.current = null;
    const publish = (event: ShellEvent) => {
      if (disposed) return;
      const updated = applyShellEvent(current.current, event);
      if (updated === current.current) return;
      if (event.type !== "output" && archived.current?.terminalId === activeId && current.current) {
        const latest = mergeShellTimeline(updated!, current.current);
        const commands = new Map(latest.commands.map(item => [item.id, item]));
        const runs = new Map(latest.runs.map(item => [item.id, item]));
        const retained = { ...archived.current, commands: archived.current.commands.map(item => commands.get(item.id) || item), runs: archived.current.runs.map(item => runs.get(item.id) || item) };
        archived.current = retained; setArchive(retained);
      }
      current.current = updated;
      if (event.type !== "output") setSnapshot(updated);
      if (event.type === "error") setError(event.error);
      if (event.type === "session" || event.type === "snapshot") {
        const state = event.type === "session" ? event.session : event.snapshot.session;
        setInventory(previous => previous.cwd === cwd ? { cwd, sessions: previous.sessions.map(item => item.id === state.id ? state : item) } : previous);
      }
      for (const listener of subscribers.current) listener(event);
    };
    let events: EventSource | undefined;
    const publishSnapshot = (next: ShellSnapshot) => {
      publish({ type: "snapshot", snapshot: next, terminalId: activeId, generation: next.session.generation, sequence: next.sequence });
      if (!disposed) setConnected(true);
    };
    const reconcile = async () => {
      if (document.hidden || reconciling || disposed) return;
      reconciling = true;
      try {
        const next = await shellRequest<ShellSnapshot>(`sessions/${activeId}`, undefined, { signal: controller.signal });
        publishSnapshot(next);
      } catch (cause) { if (!disposed) setError(String(cause)); }
      finally { reconciling = false; }
    };
    // Finish the short startup request before reserving a long-lived HTTP/1
    // connection. Its snapshot also makes the terminal usable if SSE stalls.
    void (async () => {
      const next = await shellRequest<ShellSnapshot>(`sessions/${activeId}/actions`, { action: "start" }, { signal: controller.signal });
      if (disposed) return;
      publishSnapshot(next);
      events = new EventSource(`/api/shell/sessions/${encodeURIComponent(activeId)}/events`);
      events.onmessage = event => { if (disposed) return; try { publish(JSON.parse(event.data)); sseConnected = true; setConnected(true); } catch { /* Ignore invalid transport frames. */ } };
      events.onerror = () => { if (!disposed) { sseConnected = false; setConnected(false); } };
    })().catch(cause => { if (!disposed) setError(String(cause)); });
    void pendingShellSubmissions(activeId).then(items => { if (!disposed) setPending(items); }).catch(cause => { if (!disposed) setError(String(cause)); });
    const refresh = () => {
      if (document.hidden || disposed) return;
      const state = current.current?.session;
      if (state?.activeRunId || state?.activeCommandId || !sseConnected) void reconcile();
      // Background PTYs have their own event stream. Discover them without
      // changing the user's selected terminal, including after the parent ends.
      if (state?.activeRunId || Date.now() - lastInventory >= 10000) {
        lastInventory = Date.now();
        void refreshSessions().catch(cause => { if (!disposed) setError(String(cause)); });
      }
    };
    const resume = () => { lastInventory = 0; void reconcile(); refresh(); };
    const timer = setInterval(refresh, 2500);
    window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => { disposed = true; controller.abort(); events?.close(); clearInterval(timer); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); };
  }, [activeId, cwd, refreshSessions]);
  const action = useCallback(async (body: object) => {
    if (!activeId) return;
    try { setError(""); await shellRequest(`sessions/${activeId}/actions`, body); } catch (cause) { setError(String(cause)); throw cause; }
  }, [activeId]);
  const submit = useCallback((text: string, mode: ShellInputMode, references: ShellReference[], retry?: ShellSubmission): Promise<"accepted" | "ambiguous" | "failed"> => {
    if (!activeId || retry && retry.terminalId !== activeId) return Promise.resolve("failed");
    const inFlight = sending.current.get(activeId); if (inFlight) return inFlight;
    const operation = (async (): Promise<"accepted" | "ambiguous" | "failed"> => {
      try {
        const stored = await pendingShellSubmissions(activeId);
        const matches = (item: ShellSubmission) => !confirmed.current.has(item.clientRequestId) && item.text === text && item.mode === mode && JSON.stringify(item.references) === JSON.stringify(references);
        const previous = attempts.current.get(activeId);
        const submission = retry || (previous && matches(previous) ? previous : stored.findLast(matches)) || { terminalId: activeId, clientRequestId: crypto.randomUUID(), text, mode, references, createdAt: Date.now() };
        attempts.current.set(activeId, submission);
        await saveShellSubmission(submission);
        if (active.current === activeId) { setError(""); setPending([...stored.filter(item => item.clientRequestId !== submission.clientRequestId), submission]); }
        const result = await shellRequest<{ accepted: boolean; durable?: boolean; intent?: string }>(`sessions/${submission.terminalId}/actions`, { action: "submit", ...submission });
        if (!result.durable && result.intent !== "ambiguous") throw new Error("Shell did not confirm a durable receipt");
        confirmed.current.add(submission.clientRequestId); attempts.current.delete(activeId);
        // A server receipt already proves acceptance. Local archive cleanup
        // failing must not tell the composer to resubmit under a new identity.
        try {
          await confirmShellSubmission(submission.clientRequestId);
          if (active.current === activeId) setPending(items => items.filter(item => item.clientRequestId !== submission.clientRequestId));
        } catch (cause) { if (active.current === activeId) setError(String(cause)); }
        return result.accepted ? "accepted" : "ambiguous";
      } catch (cause) { if (active.current === activeId) setError(String(cause)); return "failed"; }
    })().finally(() => { sending.current.delete(activeId); });
    sending.current.set(activeId, operation); return operation;
  }, [activeId]);
  const close = useCallback(async (id: string) => {
    try { await shellRequest(`sessions/${id}`, undefined, { method: "DELETE" }); const list = await refreshSessions(); if (scope.current === cwd && active.current === id) setSelection({ cwd, id: list[0]?.id || null }); }
    catch (cause) { setError(String(cause)); }
  }, [cwd, refreshSessions]);
  const loadArchive = useCallback(async (initial = false) => {
    if (!activeId) return;
    const previous = !initial && archived.current?.terminalId === activeId ? archived.current : null;
    if (!initial && (!previous || !previous.nextCursor && !previous.failed || previous.loading)) return;
    archiveRequest.current?.abort();
    const controller = new AbortController(); archiveRequest.current = controller;
    const value = { commands: previous?.commands || [], runs: previous?.runs || [], nextCursor: previous?.nextCursor || null, terminalId: activeId, loading: true, failed: false };
    archived.current = value; setArchive(value);
    try {
      const page = await shellRequest<ShellTimelinePage>(`sessions/${activeId}/timeline${previous?.nextCursor ? `?before=${previous.nextCursor}` : ""}`, undefined, { signal: controller.signal });
      if (controller.signal.aborted || active.current !== activeId) return;
      const retained = archived.current?.terminalId === activeId ? archived.current : value;
      const next = { terminalId: activeId, loading: false, failed: false, nextCursor: page.nextCursor, commands: [...new Map([...page.commands, ...retained.commands].map(item => [item.id, item])).values()], runs: [...new Map([...page.runs, ...retained.runs].map(item => [item.id, item])).values()] };
      archived.current = next; setArchive(next);
    } catch (cause) { if (!controller.signal.aborted && active.current === activeId) { const next = { ...(archived.current?.terminalId === activeId ? archived.current : value), loading: false, failed: true }; archived.current = next; setArchive(next); setError(String(cause)); } }
  }, [activeId]);
  useEffect(() => { void loadArchive(true); return () => archiveRequest.current?.abort(); }, [loadArchive]);
  const combined = useMemo(() => snapshot?.session.id === activeId ? archive?.terminalId === activeId ? mergeShellTimeline(snapshot, archive) : snapshot : null, [snapshot, archive, activeId]);
  return { sessions, activeId, select, create, close, snapshot: combined, getSnapshot: () => current.current, subscribe, action, submit, pending, error, setError, connected, refreshSessions, loadOlder: () => loadArchive(), hasOlder: archive?.terminalId === activeId && Boolean(archive.nextCursor || archive.failed), loadingOlder: archive?.terminalId === activeId && archive.loading };
}
