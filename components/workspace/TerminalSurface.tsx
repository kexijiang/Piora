"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { copyText, readClipboardText } from "@/lib/clipboard";
import { isTerminalProtocolReply } from "@/lib/terminal-input";
import type { ShellEvent } from "@/lib/shell/types";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

export interface TerminalSurfaceHandle {
  focus(): void;
  search(query: string, previous?: boolean): void;
  clear(): void;
}
interface Props {
  cwd?: string | null;
  terminalId?: string;
  subscribeToShell?: (listener: (event: ShellEvent) => void) => () => void;
  inputEnabled?: boolean;
  output?: string;
  readOnly?: boolean;
  onStatus?: (connected: boolean, shell: string) => void;
  onError?: (error: string) => void;
}

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, Props>(function TerminalSurface({ cwd, terminalId, subscribeToShell, inputEnabled = true, output = "", readOnly = false, onStatus, onError }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const previousOutput = useRef("");
  const outputWriter = useRef<((value: string, snapshot?: boolean) => void) | null>(null);
  const latest = useRef({ output, onStatus, onError, inputEnabled });
  useEffect(() => { latest.current = { output, onStatus, onError, inputEnabled }; });
  useImperativeHandle(ref, () => ({
    focus: () => terminal.current?.focus(),
    search: (query, previous) => {
      if (!query) search.current?.clearDecorations();
      else if (previous) search.current?.findPrevious(query);
      else search.current?.findNext(query);
    },
    clear: () => { terminal.current?.clear(); },
  }), []);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const abort = new AbortController();
    if (!readOnly) latest.current.onStatus?.(false, "");
    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
        import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search"),
      ]);
      if (disposed || !host.current) return;
      const configuredFontSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size")) || 14;
      const term = new Terminal({
        cursorBlink: !readOnly, cursorStyle: "bar", cursorInactiveStyle: "none", disableStdin: readOnly || !latest.current.inputEnabled,
        allowTransparency: true,
        convertEol: readOnly, scrollback: 5000, fontSize: configuredFontSize * 13 / 14, lineHeight: 1.35,
        fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
        theme: { background: "#00000000", foreground: "#dce3ec", cursor: "#80d4c4", selectionBackground: "#324454",
          black: "#202832", red: "#f08c96", green: "#89d4ae", yellow: "#e8c88d", blue: "#8db5f5", magenta: "#c1a0ed", cyan: "#80d4c4", white: "#dce3ec",
          brightBlack: "#748192", brightRed: "#ffacb4", brightGreen: "#b2e9c7", brightYellow: "#ffe1a3", brightBlue: "#bad1ff", brightMagenta: "#dfc7ff", brightCyan: "#b0f0e4", brightWhite: "#ffffff" },
      });
      const fit = new FitAddon();
      const finder = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(finder);
      term.open(host.current);
      terminal.current = term;
      search.current = finder;
      let chain = Promise.resolve();
      let rendering = Promise.resolve();
      let replaying = false;
      let generation = -1, sequence = -1, renderEpoch = 0;
      let pendingOutput = "", pendingReset = false, hasPendingOutput = false;
      const fitVisibleHost = () => {
        const element = host.current;
        // A display:none ancestor leaves computed width as "100%". FitAddon
        // parses that as 100 pixels, collapsing the terminal to a few columns.
        if (!element?.clientWidth || !element.clientHeight) return false;
        const dimensions = fit.proposeDimensions();
        if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return false;
        fit.fit();
        return true;
      };
      const flushOutput = () => {
        if (!hasPendingOutput || !fitVisibleHost()) return;
        const output = pendingOutput, snapshot = pendingReset;
        pendingOutput = ""; pendingReset = false; hasPendingOutput = false;
        if (snapshot) renderEpoch++;
        const epoch = renderEpoch;
        // xterm parses writes asynchronously. Keep the replay flag scoped to
        // the actual parse, including when live frames follow a large snapshot.
        rendering = rendering.then(() => new Promise<void>((resolve) => {
          if (disposed || epoch !== renderEpoch) { resolve(); return; }
          replaying = snapshot;
          if (snapshot) term.reset();
          term.write(output, () => { replaying = false; resolve(); });
        }));
      };
      const writeOutput = (output: string, snapshot = false) => {
        pendingOutput = (snapshot ? output : pendingOutput + output).slice(-500_000);
        pendingReset ||= snapshot;
        hasPendingOutput = true;
        flushOutput();
      };
      outputWriter.current = writeOutput;
      let events: EventSource | undefined;
      let unsubscribe: (() => void) | undefined;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      let resizeFrame = 0;
      let lastResize = "";
      const post = (body: object) => {
        const queuedGeneration = generation;
        chain = chain.then(async () => {
          if (disposed) return;
          if (terminalId && queuedGeneration !== generation) return;
          const response = await fetch(terminalId ? `/api/shell/sessions/${terminalId}/actions` : "/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, ...body, ...(terminalId ? { generation: queuedGeneration } : {}) }), signal: abort.signal });
          if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
        }).catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
      };
      const resize = () => {
        cancelAnimationFrame(resizeFrame);
        if (disposed) return;
        if (!host.current?.clientWidth || !host.current.clientHeight) return;
        if (!fitVisibleHost()) { resizeFrame = requestAnimationFrame(resize); return; }
        flushOutput();
        const key = `${generation}:${term.cols}:${term.rows}`;
        if (!readOnly && cwd && key !== lastResize) { lastResize = key; post({ action: "resize", cols: term.cols, rows: term.rows }); }
      };
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 80);
      });
      observer.observe(host.current);
      resize();
      if (readOnly) {
        previousOutput.current = latest.current.output;
        writeOutput(latest.current.output, true);
      } else if (cwd) {
        // EventSource hides HTTP error bodies. Start explicitly so missing
        // native libraries and invalid working directories reach the user.
        void (async () => {
          if (disposed) return;
          const onMessage = (event: { data: string }) => {
            if (disposed) return;
            try {
              const message = JSON.parse(event.data);
              if (terminalId) {
                if (message.terminalId !== terminalId || !Number.isInteger(message.generation) || !Number.isInteger(message.sequence)) return;
                if (message.generation < generation || message.generation === generation && (message.sequence < sequence || message.sequence === sequence && message.type !== "snapshot")) return;
                if (message.generation > generation) renderEpoch++;
                generation = message.generation; sequence = message.sequence;
              }
              if (message.type === "snapshot") { writeOutput(terminalId ? message.snapshot.output : message.output, true); resize(); }
              else if (message.type === "output") writeOutput(terminalId ? message.data : message.output);
              else if (message.type === "clear") writeOutput("", true);
              else if (message.type === "error") latest.current.onError?.(message.error);
              if (terminalId && (message.type === "snapshot" || message.type === "session")) {
                const session = message.type === "snapshot" ? message.snapshot.session : message.session;
                term.options.disableStdin = !latest.current.inputEnabled || session.owner === "agent";
                latest.current.onStatus?.(session.connected, session.profile.label);
              } else if (message.type === "snapshot" || message.type === "status") latest.current.onStatus?.(message.connected, message.shell);
            } catch { /* Ignore malformed transport frames. */ }
          };
          // The command cards already own this shell's stream. Reuse it rather
          // than occupying a second HTTP/1 connection for the native viewport.
          if (terminalId && subscribeToShell) {
            unsubscribe = subscribeToShell(message => onMessage({ data: JSON.stringify(message) }));
            return;
          }
          // Startup returns as soon as the PTY exists, before profiles finish.
          // Use that snapshot before SSE reserves a long-lived HTTP connection.
          const response = await fetch(terminalId ? `/api/shell/sessions/${terminalId}/actions` : "/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, action: "start" }), signal: abort.signal });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error ?? `HTTP ${response.status}`);
          }
          const snapshot = await response.json();
          if (disposed) return;
          onMessage({ data: JSON.stringify(terminalId
            ? { type: "snapshot", terminalId, generation: snapshot.session.generation, sequence: snapshot.sequence, snapshot }
            : { type: "snapshot", ...snapshot }) });
          events = new EventSource(terminalId ? `/api/shell/sessions/${terminalId}/events` : `/api/terminal/events?cwd=${encodeURIComponent(cwd)}`);
          events.onmessage = onMessage;
          events.onerror = () => { if (!disposed) latest.current.onStatus?.(false, ""); };
        })().catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
      }
      const input = term.onData((data) => { if (!readOnly && cwd && (latest.current.inputEnabled || isTerminalProtocolReply(data))) post({ action: "input", data, ...(replaying && isTerminalProtocolReply(data) ? { replay: true } : {}) }); });
      term.attachCustomKeyEventHandler((event) => {
        const pasteShortcut = !event.altKey && (
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")
          || (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === "Insert")
        );
        if (pasteShortcut) {
          if (readOnly || !cwd || !latest.current.inputEnabled) {
            event.preventDefault();
          } else if (window.piDesktop?.clipboard) {
            // Electron clipboard reads use the trusted preload bridge. Prevent
            // native paste too, otherwise the same text can arrive twice.
            event.preventDefault();
            if (event.type === "keydown" && !event.repeat) {
              void readClipboardText().then((text) => {
                if (!disposed && text) term.paste(text);
              }).catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
            }
          }
          // In browsers leave the native paste event enabled, but never let
          // xterm turn Ctrl+V into a shell control character (0x16).
          return false;
        }
        if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
          event.preventDefault();
          void copyText(term.getSelection()).catch((error) => latest.current.onError?.(String(error)));
          return false;
        }
        return true;
      });
      // Let terminal control keys reach the shell instead of global app shortcuts.
      const stopShortcut = (event: KeyboardEvent) => {
        event.stopPropagation();
      };
      const element = host.current;
      element.addEventListener("keydown", stopShortcut);
      cleanup = () => {
        clearTimeout(resizeTimer); cancelAnimationFrame(resizeFrame); observer.disconnect(); events?.close(); unsubscribe?.(); input.dispose();
        element.removeEventListener("keydown", stopShortcut); term.dispose();
        terminal.current = null; search.current = null; outputWriter.current = null; previousOutput.current = "";
      };
    })().catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
    return () => { disposed = true; abort.abort(); cleanup(); };
  }, [cwd, readOnly, terminalId, subscribeToShell]);

  useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = readOnly || !inputEnabled; }, [inputEnabled, readOnly]);

  useEffect(() => {
    if (!readOnly || !terminal.current) return;
    const previous = previousOutput.current;
    if (output.startsWith(previous)) outputWriter.current?.(output.slice(previous.length));
    else outputWriter.current?.(output, true);
    previousOutput.current = output;
  }, [output, readOnly]);

  return <div ref={host} className={styles.surface} data-terminal-surface={readOnly ? "agent" : "shell"} />;
});
