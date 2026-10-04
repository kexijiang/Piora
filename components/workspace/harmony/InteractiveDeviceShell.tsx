"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { readClipboardText, copyText } from "@/lib/clipboard";
import "@xterm/xterm/css/xterm.css";

interface Props { serial: string; scope: HarmonyFileScope; chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>;
  onOutputChange?: (output: string) => void; searchTarget?: { query: string; revision: number }; clientTerminalId?: string; visible?: boolean; onStatusChange?: (status: "idle" | "connecting" | "connected" | "disconnected") => void }

type OwnedSession = { id: string; token: string; stopping?: Promise<void> };
const STREAM_INTERRUPTED = "设备 Shell 流中断 / Device shell stream interrupted";

class TerminalRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function post(body: Record<string, unknown>, keepalive = false) {
  const response = await fetch("/api/harmony/device-terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  const value = await response.json();
  if (!response.ok) throw new TerminalRequestError(value.error?.message ?? value.error ?? `HTTP ${response.status}`, response.status);
  return value;
}

function stopSession(session: OwnedSession, keepalive = true): Promise<void> {
  // An explicit close and panel teardown share one request. A failed close can be retried.
  if (session.stopping) return session.stopping;
  session.stopping = post({ action: "stop", id: session.id, leaseToken: session.token }, keepalive).then(() => undefined).catch(cause => {
    if (cause instanceof TerminalRequestError && cause.status === 404) return;
    session.stopping = undefined;
    throw cause;
  });
  return session.stopping;
}

function containsTerminalControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 9 || code === 11 || code === 12 || code > 13 && code < 32 || code === 127) return true;
  }
  return false;
}

export function InteractiveDeviceShell({ serial, scope, chinese, canControl, ensureControl, onOutputChange, searchTarget, clientTerminalId, visible = true, onStatusChange }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [pasteDraft, setPasteDraft] = useState<string | null>(null);
  const [disconnectedOutput, setDisconnectedOutput] = useState("");
  const statusListener = useRef(onStatusChange); statusListener.current = onStatusChange;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const [streamReady, setStreamReady] = useState(false);
  const [fallbackClientId] = useState(() => crypto.randomUUID());
  const sendInput = useRef<((data: string) => void) | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const searchRef = useRef<import("@xterm/addon-search").SearchAddon | null>(null);
  const outputRef = useRef("");
  const outputListener = useRef(onOutputChange); outputListener.current = onOutputChange;
  const requestedSearch = useRef(searchTarget); requestedSearch.current = searchTarget;
  const ownedSession = useRef<OwnedSession | null>(null);
  const operation = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode replays effects synchronously. Only a real detach releases the PTY.
      queueMicrotask(() => {
        if (!mounted.current && ownedSession.current) void stopSession(ownedSession.current, true).catch(() => undefined);
      });
    };
  }, []);
  useEffect(() => { onOutputChange?.(outputRef.current); }, [onOutputChange]);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const start = async (reconnect = false) => {
    if (operation.current || ownedSession.current && !reconnect || !canControl) return;
    operation.current = true;
    setBusy(true); setError(null);
    try {
      if (reconnect && ownedSession.current) {
        const previous = ownedSession.current;
        setDisconnectedOutput(outputRef.current);
        setConnected(false); setPasteDraft(null);
        await stopSession(previous);
        if (ownedSession.current === previous) ownedSession.current = null;
        if (!mounted.current) return;
        setId(null);
      }
      const token = await ensureControl();
      if (!mounted.current) return;
      const result = await post({ action: "start", serial, leaseToken: token, kind: scope.kind, clientTerminalId: clientTerminalId ?? fallbackClientId,
        ...(scope.kind === "sandbox" ? { bundleName: scope.bundleName } : {}) });
      const session: OwnedSession = { id: result.id, token };
      if (!mounted.current) {
        void stopSession(session, true).catch(() => undefined);
        return;
      }
      ownedSession.current = session;
      setStreamReady(false); setConnected(false); setId(result.id);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { statusListener.current?.(busy || id && !streamReady ? "connecting" : connected ? "connected" : id ? "disconnected" : "idle"); }, [busy, connected, id, streamReady]);
  const stop = async () => {
    const session = ownedSession.current;
    if (!session || operation.current) return;
    operation.current = true;
    setBusy(true); setError(null); setConnected(false); setPasteDraft(null);
    try {
      await stopSession(session);
      if (ownedSession.current === session) ownedSession.current = null;
      if (mounted.current) { setId(null); setDisconnectedOutput(""); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { if (visible && id && searchTarget?.query) searchRef.current?.findNext(searchTarget.query); }, [visible, id, searchTarget?.revision, searchTarget?.query]);

  useEffect(() => {
    const session = ownedSession.current;
    if (!id || !host.current || session?.id !== id) return;
    const token = session.token;
    let disposed = false;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let events: EventSource | undefined;
    let observer: ResizeObserver | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let streamConnected = false;
    const publishOutput = (next: string) => {
      outputRef.current = next.slice(-200_000);
      if (outputListener.current && !outputTimer) outputTimer = setTimeout(() => { outputTimer = undefined; if (!disposed) outputListener.current?.(outputRef.current); }, 150);
    };
    const keepalive = setInterval(() => {
      if (operation.current) return;
      void post({ action: "keepalive", id, leaseToken: token }).catch(cause => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 60_000);
    let inputQueue = Promise.resolve();
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
      if (visibleRef.current) terminal.focus();
      const resize = () => {
        if (!host.current?.clientWidth || !host.current.clientHeight || !terminal) return;
        fit.fit();
        void post({ action: "resize", id, leaseToken: token, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      };
      observer = new ResizeObserver(resize); observer.observe(host.current); resize();
      const writeInput = (data: string) => {
        inputQueue = inputQueue.then(() => {
          if (disposed || operation.current || !streamConnected) return;
          return post({ action: "input", id, leaseToken: token, data });
        }).then(() => undefined).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
      };
      sendInput.current = writeInput;
      terminal.onData(writeInput);
      events = new EventSource(`/api/harmony/device-terminal?id=${encodeURIComponent(id)}`);
      events.onmessage = event => {
        if (disposed || !terminal) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") { terminal.reset(); publishOutput(message.output); terminal.write(message.output, () => { if (visibleRef.current && requestedSearch.current?.query) searchRef.current?.findNext(requestedSearch.current.query); }); streamConnected = message.connected; setStreamReady(true); setConnected(message.connected); if (message.connected) setError(current => current === STREAM_INTERRUPTED ? null : current); }
          else if (message.type === "output") { publishOutput(outputRef.current + message.data); terminal.write(message.data); }
          else if (message.type === "status") { streamConnected = message.connected; setStreamReady(true); setConnected(message.connected); if (!message.connected) events?.close(); }
        } catch { /* Ignore malformed frame. */ }
      };
      events.onerror = () => { if (!disposed) { streamConnected = false; setStreamReady(true); setConnected(false); setError(STREAM_INTERRUPTED); } };
    })().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      disposed = true; clearInterval(keepalive); clearTimeout(outputTimer); observer?.disconnect(); events?.close(); terminal?.dispose();
      terminalRef.current = null; searchRef.current = null; sendInput.current = null;
      outputRef.current = ""; outputListener.current?.("");
    };
  }, [id]);

  return <section aria-label={copy("交互式设备 Shell", "Interactive device shell")}>
    <h4>{copy("交互式设备 Shell", "Interactive device shell")}</h4>
    <p>{copy("目标设备：", "Target device: ")}{serial} · {scope.kind === "sandbox" ? scope.bundleName : copy("设备 Shell", "Device shell")}</p>
    <p>{copy("保留 cd 与环境变量。关闭标签或设备任务结束时关闭会话；断线后的设备端副作用仍需核对。调试沙箱需要设备与 HDC 支持 shell -b。",
      "Preserves cd and environment changes. Closing the tab or ending the device task closes the session. Verify effects after a disconnect. Debug sandboxes require device and HDC support for shell -b.")}</p>
    {id ? <button disabled={busy} onClick={() => void stop()}>{copy("关闭设备 Shell", "Close device shell")}</button>
      : <button disabled={busy || !canControl || scope.kind === "sandbox" && !scope.bundleName.trim()} onClick={() => void start()}>
        {busy ? copy("正在连接…", "Connecting…") : copy("打开设备 Shell", "Open device shell")}</button>}
    {id ? <span aria-live="polite"> {busy ? copy("正在结束旧会话…", "Ending the current session…") : !streamReady ? copy("正在连接…", "Connecting…") : connected ? copy("已连接", "Connected") : copy("已断开", "Disconnected")}</span> : null}
    {id && streamReady && !connected ? <button disabled={busy || !canControl} onClick={() => void start(true)}>{copy("重连新会话", "Reconnect a new session")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {disconnectedOutput ? <details><summary>{copy("上次断线的输出", "Previous disconnected output")}</summary><pre style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>{disconnectedOutput}</pre></details> : null}
    {id ? <div>
      <label>{copy("搜索终端输出", "Search terminal output")}<input value={searchText} onChange={event => { setSearchText(event.target.value); if (!event.target.value) searchRef.current?.clearDecorations(); }} onKeyDown={event => { if (event.key === "Enter" && searchText) { event.preventDefault(); searchRef.current?.findNext(searchText); } }} /></label>
      <button disabled={!searchText} onClick={() => searchRef.current?.findPrevious(searchText)}>{copy("上一个", "Previous")}</button>
      <button disabled={!searchText} onClick={() => searchRef.current?.findNext(searchText)}>{copy("下一个", "Next")}</button>
      <button onClick={() => { const selection = terminalRef.current?.getSelection(); if (selection) void copyText(selection).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>{copy("复制选中", "Copy selection")}</button>
      <button disabled={!connected || busy} onClick={() => void readClipboardText().then(value => { if (mounted.current && ownedSession.current?.id === id && !operation.current) setPasteDraft(value); }).catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); })}>{copy("粘贴", "Paste")}</button>
      <button onClick={() => { terminalRef.current?.clear(); outputRef.current = ""; outputListener.current?.(""); }}>{copy("清屏", "Clear display")}</button>
      <button disabled={!connected || busy} onClick={() => sendInput.current?.("\u0003")}>{copy("中断命令（Ctrl+C）", "Interrupt command (Ctrl+C)")}</button>
    </div> : null}
    {pasteDraft !== null ? <div role="group" aria-label={copy("检查粘贴文本", "Review pasted text")}>
      <p>{copy("粘贴仅填入此草稿。检查后可填入单行输入，或明确执行。", "Pasting only fills this draft. Review before inserting one input line or explicitly running it.")}</p>
      <label>{copy("待粘贴文本", "Text to paste")}<textarea rows={5} value={pasteDraft} style={{ width: "100%" }} onChange={event => setPasteDraft(event.target.value)} /></label>
      {pasteDraft.length > 16_000 || containsTerminalControls(pasteDraft) ? <p role="alert">{copy("文本超过 16000 字符或含终端控制字符，请修改后发送。", "Edit text longer than 16000 characters or containing terminal control characters before sending.")}</p> : null}
      <button disabled={!connected || busy || !pasteDraft || pasteDraft.length > 16_000 || (/[\r\n]/.test(pasteDraft) || containsTerminalControls(pasteDraft))} onClick={() => { terminalRef.current?.paste(pasteDraft); setPasteDraft(null); terminalRef.current?.focus(); }}>{copy("填入终端输入行", "Insert into terminal input")}</button>
      <button disabled={!connected || busy || !pasteDraft || pasteDraft.length > 16_000 || containsTerminalControls(pasteDraft)} onClick={() => { const data = pasteDraft.replace(/\r\n?/g, "\n").replace(/\n/g, "\r"); sendInput.current?.(data.endsWith("\r") ? data : data + "\r"); setPasteDraft(null); terminalRef.current?.focus(); }}>{copy("执行已检查文本", "Run reviewed text")}</button>
      <button onClick={() => { setPasteDraft(null); terminalRef.current?.focus(); }}>{copy("取消粘贴", "Cancel paste")}</button>
    </div> : null}
    {id ? <div ref={host} onPasteCapture={event => { event.preventDefault(); event.stopPropagation(); if (connected && !busy) setPasteDraft(event.clipboardData.getData("text/plain")); }} style={{ height: 300, minWidth: 0, width: "100%", overflow: "hidden", background: "#111820" }} /> : null}
  </section>;
}
