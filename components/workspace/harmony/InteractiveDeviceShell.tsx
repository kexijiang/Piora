"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import "@xterm/xterm/css/xterm.css";

interface Props { serial: string; scope: HarmonyFileScope; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>;
  onOutputChange?: (output: string) => void; searchTarget?: { query: string; revision: number } }

export function InteractiveDeviceShell({ serial, scope, chinese, canControl, ensureControl, onOutputChange, searchTarget }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const searchRef = useRef<import("@xterm/addon-search").SearchAddon | null>(null);
  const outputRef = useRef("");
  const outputListener = useRef(onOutputChange); outputListener.current = onOutputChange;
  const requestedSearch = useRef(searchTarget); requestedSearch.current = searchTarget;
  const leaseToken = useRef("");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onOutputChange?.(outputRef.current); }, [onOutputChange]);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/harmony/device-terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? value.error ?? `HTTP ${response.status}`);
    return value;
  };
  const start = async () => {
    if (busy || id || !canControl) return;
    setBusy(true); setError(null);
    try {
      const token = await ensureControl();
      if (!mounted.current) return;
      const result = await post({ action: "start", serial, leaseToken: token, kind: scope.kind,
        ...(scope.kind === "sandbox" ? { bundleName: scope.bundleName } : {}) });
      if (!mounted.current) {
        void post({ action: "stop", id: result.id, leaseToken: token }).catch(() => undefined);
        return;
      }
      leaseToken.current = token;
      setId(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const stop = () => {
    if (!id) return;
    const current = id;
    setId(null); setConnected(false); outputRef.current = ""; outputListener.current?.("");
    void post({ action: "stop", id: current, leaseToken: leaseToken.current }).catch(() => undefined);
  };
  useEffect(() => { if (id && searchTarget?.query) searchRef.current?.findNext(searchTarget.query); }, [id, searchTarget?.revision, searchTarget?.query]);

  useEffect(() => {
    if (!id || !host.current) return;
    let disposed = false;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let events: EventSource | undefined;
    let observer: ResizeObserver | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    const publishOutput = (next: string) => {
      outputRef.current = next.slice(-200_000);
      if (outputListener.current && !outputTimer) outputTimer = setTimeout(() => { outputTimer = undefined; if (!disposed) outputListener.current?.(outputRef.current); }, 150);
    };
    const keepalive = setInterval(() => {
      void post({ action: "keepalive", id, leaseToken: leaseToken.current }).catch(cause => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 60_000);
    let inputQueue = Promise.resolve();
    const token = leaseToken.current;
    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search")]);
      if (disposed || !host.current) return;
      const configuredFontSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size")) || 14;
      terminal = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: configuredFontSize * 13 / 14,
        fontFamily: '"Cascadia Code", Consolas, monospace', theme: { background: "#111820", foreground: "#e6edf3" } });
      const fit = new FitAddon(); terminal.loadAddon(fit);
      const search = new SearchAddon(); terminal.loadAddon(search);
      terminalRef.current = terminal; searchRef.current = search;
      terminal.open(host.current);
      terminal.focus();
      const resize = () => {
        if (!host.current?.clientWidth || !host.current.clientHeight || !terminal) return;
        fit.fit();
        void post({ action: "resize", id, leaseToken: token, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      };
      observer = new ResizeObserver(resize); observer.observe(host.current); resize();
      terminal.onData(data => {
        inputQueue = inputQueue.then(() => post({ action: "input", id, leaseToken: token, data })).then(() => undefined)
          .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
      });
      events = new EventSource(`/api/harmony/device-terminal?id=${encodeURIComponent(id)}`);
      events.onmessage = event => {
        if (disposed || !terminal) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") { terminal.reset(); publishOutput(message.output); terminal.write(message.output, () => { if (requestedSearch.current?.query) searchRef.current?.findNext(requestedSearch.current.query); }); setConnected(message.connected); }
          else if (message.type === "output") { publishOutput(outputRef.current + message.data); terminal.write(message.data); }
          else if (message.type === "status") setConnected(message.connected);
        } catch { /* Ignore malformed frame. */ }
      };
      events.onerror = () => { if (!disposed) setError("设备 Shell 流中断 / Device shell stream interrupted"); };
    })().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      disposed = true; clearInterval(keepalive); clearTimeout(outputTimer); observer?.disconnect(); events?.close(); terminal?.dispose();
      terminalRef.current = null; searchRef.current = null;
      outputRef.current = ""; outputListener.current?.("");
      void fetch("/api/harmony/device-terminal", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id, leaseToken: token }), keepalive: true }).catch(() => undefined);
    };
  }, [id]);

  return <section aria-label={copy("交互式设备 Shell", "Interactive device shell")}>
    <h4>{copy("交互式设备 Shell", "Interactive device shell")}</h4>
    <p>{copy("保留 cd 与环境变量。关闭面板或控制权到期时结束会话；断线后的设备端副作用仍需核对。调试沙箱需要设备与 HDC 支持 shell -b。",
      "Preserves cd and environment changes. Closing the panel or losing control ends the session. Verify effects after a disconnect. Debug sandboxes require device and HDC support for shell -b.")}</p>
    {id ? <button onClick={stop}>{copy("关闭设备 Shell", "Close device shell")}</button>
      : <button disabled={busy || !canControl || scope.kind === "sandbox" && !scope.bundleName.trim()} onClick={() => void start()}>
        {busy ? copy("正在连接…", "Connecting…") : copy("打开设备 Shell", "Open device shell")}</button>}
    {id ? <span aria-live="polite"> {connected ? copy("已连接", "Connected") : copy("已断开", "Disconnected")}</span> : null}
    {error ? <p role="alert">{error}</p> : null}
    {id ? <div>
      <label>{copy("搜索终端输出", "Search terminal output")}<input value={searchText} onChange={event => { setSearchText(event.target.value); if (!event.target.value) searchRef.current?.clearDecorations(); }} onKeyDown={event => { if (event.key === "Enter" && searchText) { event.preventDefault(); searchRef.current?.findNext(searchText); } }} /></label>
      <button disabled={!searchText} onClick={() => searchRef.current?.findPrevious(searchText)}>{copy("上一个", "Previous")}</button>
      <button disabled={!searchText} onClick={() => searchRef.current?.findNext(searchText)}>{copy("下一个", "Next")}</button>
      <button onClick={() => { const selection = terminalRef.current?.getSelection(); if (selection) void navigator.clipboard.writeText(selection).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>{copy("复制选中", "Copy selection")}</button>
      <button onClick={() => void navigator.clipboard.readText().then(text => terminalRef.current?.paste(text)).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{copy("粘贴", "Paste")}</button>
    </div> : null}
    {id ? <div ref={host} style={{ height: 300, minWidth: 0, width: "100%", overflow: "hidden", background: "#111820" }} /> : null}
  </section>;
}
