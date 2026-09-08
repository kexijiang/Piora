"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { copyText } from "@/lib/clipboard";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

export interface TerminalSurfaceHandle {
  focus(): void;
  search(query: string, previous?: boolean): void;
  clear(): void;
}
interface Props {
  cwd?: string | null;
  output?: string;
  readOnly?: boolean;
  onStatus?: (connected: boolean, shell: string) => void;
  onError?: (error: string) => void;
}

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, Props>(function TerminalSurface({ cwd, output = "", readOnly = false, onStatus, onError }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const previousOutput = useRef("");
  const latest = useRef({ output, onStatus, onError });
  useEffect(() => { latest.current = { output, onStatus, onError }; });
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
        cursorBlink: !readOnly, cursorStyle: "bar", cursorInactiveStyle: "none", disableStdin: readOnly,
        convertEol: readOnly, scrollback: 5000, fontSize: configuredFontSize * 13 / 14, lineHeight: 1.35,
        fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
        theme: { background: "#101419", foreground: "#dce3ec", cursor: "#80d4c4", selectionBackground: "#324454",
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
      let events: EventSource | undefined;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const post = (body: object) => {
        chain = chain.then(async () => {
          if (disposed) return;
          const response = await fetch("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, ...body }), signal: abort.signal });
          if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
        }).catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
      };
      const resize = () => {
        if (!host.current?.clientWidth || !host.current.clientHeight) return;
        fit.fit();
        if (!readOnly && cwd) post({ action: "resize", cols: term.cols, rows: term.rows });
      };
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 80);
      });
      observer.observe(host.current);
      fit.fit();
      if (readOnly) {
        previousOutput.current = latest.current.output;
        term.write(latest.current.output);
      } else if (cwd) {
        // EventSource hides HTTP error bodies. Start explicitly so missing
        // native libraries and invalid working directories reach the user.
        void (async () => {
          const response = await fetch("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, action: "start" }), signal: abort.signal });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error ?? `HTTP ${response.status}`);
          }
          if (disposed) return;
          events = new EventSource(`/api/terminal/events?cwd=${encodeURIComponent(cwd)}`);
          events.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === "snapshot") { term.reset(); term.write(message.output); resize(); }
              else if (message.type === "output") term.write(message.output);
              else if (message.type === "clear") term.clear();
              if (message.type === "snapshot" || message.type === "status") latest.current.onStatus?.(message.connected, message.shell);
            } catch { /* Ignore malformed transport frames. */ }
          };
          events.onerror = () => latest.current.onStatus?.(false, "");
        })().catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
      }
      const input = term.onData((data) => { if (!readOnly && cwd) post({ action: "input", data }); });
      term.attachCustomKeyEventHandler((event) => {
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
        clearTimeout(resizeTimer); observer.disconnect(); events?.close(); input.dispose();
        element.removeEventListener("keydown", stopShortcut); term.dispose();
        terminal.current = null; search.current = null; previousOutput.current = "";
      };
    })().catch((error) => { if (!disposed) latest.current.onError?.(String(error)); });
    return () => { disposed = true; abort.abort(); cleanup(); };
  }, [cwd, readOnly]);

  useEffect(() => {
    if (!readOnly || !terminal.current) return;
    const previous = previousOutput.current;
    if (output.startsWith(previous)) terminal.current.write(output.slice(previous.length));
    else { terminal.current.reset(); terminal.current.write(output); }
    previousOutput.current = output;
  }, [output, readOnly]);

  return <div ref={host} className={styles.surface} data-terminal-surface={readOnly ? "agent" : "shell"} />;
});
