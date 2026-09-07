"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { parseAnsiLine } from "@/lib/ansi";
import { filterCommandHistory } from "@/lib/command-history";
import { AliIcon } from "../AliIcon";
import styles from "./WorkspacePanel.module.css";

const HISTORY_KEY = "piora-command-history-v1";
const HISTORY_LIMIT = 100;
const QUICK_COMMANDS = ["git status --short", "git diff --stat", "npm test", "npm run lint"];

type TerminalMessage =
  | { type: "snapshot"; connected: boolean; output: string; shell: string }
  | { type: "output"; output: string }
  | { type: "clear" }
  | { type: "status"; connected: boolean; shell: string };

export function CommandPanel({ cwd, onClose }: { cwd?: string | null; onClose?: () => void }) {
  const { t } = useI18n();
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [output, setOutput] = useState("");
  const [outputQuery, setOutputQuery] = useState("");
  const [wrapOutput, setWrapOutput] = useState(true);
  const [followOutput, setFollowOutput] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [shell, setShell] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored)) setHistory(stored.filter((item): item is string => typeof item === "string").slice(0, HISTORY_LIMIT));
    } catch { /* Ignore malformed local history. */ }
  }, []);

  useEffect(() => {
    setOutput("");
    setConnected(false);
    setError(null);
    if (!cwd) return;
    setConnecting(true);
    const events = new EventSource(`/api/terminal/events?cwd=${encodeURIComponent(cwd)}`);
    events.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as TerminalMessage;
        if (message.type === "snapshot") {
          setOutput(message.output);
          setConnected(message.connected);
          setShell(message.shell);
        } else if (message.type === "output") {
          setOutput((current) => `${current}${message.output}`.slice(-500_000));
        } else if (message.type === "clear") {
          setOutput("");
        } else if (message.type === "status") {
          setConnected(message.connected);
          setShell(message.shell);
        }
        setConnecting(false);
        setError(null);
      } catch { /* Wait for the next valid stream event. */ }
    };
    events.onerror = () => {
      setConnecting(false);
      setConnected(false);
      setError(t("commandPanel.disconnected"));
    };
    return () => events.close();
  }, [cwd, t]);

  const postAction = useCallback(async (action: "run" | "clear" | "restart" | "stop", commandValue?: string) => {
    if (!cwd) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cwd, ...(commandValue ? { command: commandValue } : {}) }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; connected?: boolean; shell?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (typeof payload?.connected === "boolean") setConnected(payload.connected);
      if (payload?.shell) setShell(payload.shell);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("commandPanel.disconnected"));
    } finally {
      setSubmitting(false);
    }
  }, [cwd, t]);

  const outputLines = useMemo(() => output.replace(/\r(?!\n)/g, "\n").split(/\r?\n/), [output]);
  const commandOptions = useMemo(() => [...history, ...QUICK_COMMANDS.filter((item) => !history.includes(item))], [history]);
  const suggestions = useMemo(() => suggestionsOpen ? filterCommandHistory(commandOptions, command) : [], [command, commandOptions, suggestionsOpen]);
  const outputMatchCount = useMemo(() => {
    const needle = outputQuery.trim().toLocaleLowerCase();
    return needle ? outputLines.reduce((count, line) => count + countMatches(line.toLocaleLowerCase(), needle), 0) : 0;
  }, [outputLines, outputQuery]);

  useEffect(() => {
    if (!followOutput || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output, followOutput]);

  const run = (commandOverride?: string) => {
    const value = (commandOverride ?? command).trim();
    if (!cwd || !value || submitting) return;
    const next = [value, ...history.filter((item) => item !== value)].slice(0, HISTORY_LIMIT);
    setHistory(next);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* Keep history in memory. */ }
    setHistoryIndex(-1);
    setSuggestionsOpen(false);
    setCommand("");
    void postAction("run", value).then(() => inputRef.current?.focus());
  };

  const chooseSuggestion = (suggestion: string) => {
    setCommand(suggestion);
    setSuggestionsOpen(false);
    inputRef.current?.focus();
  };

  const status = connecting
    ? t("commandPanel.connecting")
    : connected
      ? t("commandPanel.statusReady", { shell: shell || t("commandPanel.shell") })
      : t("commandPanel.disconnected");

  return <div className={styles.commandRoot}>
    <header className={styles.terminalHeader}>
      <div className={styles.terminalIdentity}>
        <span className={styles.terminalStatusDot} data-connected={connected || undefined} data-running={connecting || undefined} />
        <span><b>{t("commandPanel.title")}</b><small>{status}</small></span>
      </div>
      <div className={styles.terminalHeaderActions}>
        {onClose ? <button type="button" onClick={onClose} title={t("workspace.closeTool")} aria-label={t("workspace.closeTool")}><AliIcon name="close" size={13} /></button> : null}
        {cwd ? <span className={styles.terminalCwd} title={cwd}><AliIcon name="folder" size={12} />{compactCwd(cwd)}</span> : null}
        <button type="button" aria-pressed={wrapOutput} onClick={() => setWrapOutput((value) => !value)} title={wrapOutput ? t("commandPanel.unwrap") : t("commandPanel.wrap")} aria-label={wrapOutput ? t("commandPanel.unwrap") : t("commandPanel.wrap")}><AliIcon name="code" size={13} /></button>
        <button type="button" aria-pressed={followOutput} onClick={() => setFollowOutput((value) => !value)} title={followOutput ? t("commandPanel.pauseFollow") : t("commandPanel.follow")} aria-label={followOutput ? t("commandPanel.pauseFollow") : t("commandPanel.follow")}><AliIcon name="arrowdown" size={13} /></button>
        {connected ? <button type="button" disabled={submitting} onClick={() => void postAction("stop")} title={t("commandPanel.stop")} aria-label={t("commandPanel.stop")}><AliIcon name="stop" size={13} /></button> : null}
        <button type="button" disabled={!cwd || submitting} onClick={() => void postAction("restart")} title={t("commandPanel.restart")} aria-label={t("commandPanel.restart")}><AliIcon name="reload" size={13} /></button>
        <button type="button" disabled={!cwd || !output} onClick={() => { setOutput(""); setOutputQuery(""); void postAction("clear"); }} title={t("commandPanel.clearOutput")} aria-label={t("commandPanel.clearOutput")}><AliIcon name="clear" size={13} /></button>
      </div>
    </header>

    <div ref={outputRef} className={styles.terminalViewport} aria-live="polite">
      {error ? <div className={styles.terminalError} role="alert">{error}</div> : null}
      {output ? <article className={styles.terminalBlock}>
        <div className={styles.terminalFindBar}>
          <AliIcon name="search" size={12} />
          <input value={outputQuery} onChange={(event) => setOutputQuery(event.target.value)} placeholder={t("commandPanel.findOutput")} aria-label={t("commandPanel.findOutput")} />
          {outputQuery ? <><span>{t("commandPanel.findMatches", { count: outputMatchCount })}</span><button type="button" onClick={() => setOutputQuery("")} aria-label={t("review.clearSearch")}><AliIcon name="close" size={11} /></button></> : null}
        </div>
        <pre data-wrap={wrapOutput || undefined}>{outputLines.map((line, lineIndex) => <span className={styles.terminalOutputLine} key={lineIndex}>{parseAnsiLine(line).map((segment, segmentIndex) => <span key={segmentIndex} style={segment.style}>{highlightText(segment.text, outputQuery)}</span>)}{"\n"}</span>)}</pre>
      </article> : <div className={styles.terminalEmpty}>
        <span className={styles.terminalEmptyIcon}><AliIcon name="code" size={18} /></span>
        <b>{cwd ? t("commandPanel.emptyTitle") : t("commandPanel.noWorkspace")}</b>
        <span>{cwd ? t("commandPanel.empty") : t("commandPanel.noWorkspaceDescription")}</span>
        {cwd ? <div className={styles.terminalQuickCommands} aria-label={t("commandPanel.quickCommands")}>
          {QUICK_COMMANDS.map((quickCommand) => <button key={quickCommand} type="button" onClick={() => chooseSuggestion(quickCommand)}><code>{quickCommand}</code></button>)}
        </div> : null}
      </div>}
    </div>

    <footer className={styles.terminalComposer}>
      <div className={styles.commandInputWrap}>
        <span className={styles.terminalInputPrompt}>❯</span>
        <input
          ref={inputRef}
          value={command}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls="command-history-suggestions"
          aria-activedescendant={suggestions[suggestionIndex] ? `command-history-option-${suggestionIndex}` : undefined}
          onFocus={() => setSuggestionsOpen(true)}
          onBlur={() => setSuggestionsOpen(false)}
          onChange={(event) => { setCommand(event.target.value); setHistoryIndex(-1); setSuggestionIndex(0); setSuggestionsOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); run(suggestions[suggestionIndex]); }
            else if (event.key === "Tab" && suggestions[suggestionIndex]) { event.preventDefault(); chooseSuggestion(suggestions[suggestionIndex]); }
            else if (event.key === "Escape" && suggestions.length) { event.preventDefault(); setSuggestionsOpen(false); }
            else if (event.key === "ArrowDown" && suggestions.length) { event.preventDefault(); setSuggestionIndex((current) => (current + 1) % suggestions.length); }
            else if (event.key === "ArrowUp" && suggestions.length) { event.preventDefault(); setSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length); }
            else if (event.key === "ArrowUp" && history.length) { event.preventDefault(); const next = Math.min(history.length - 1, historyIndex + 1); setHistoryIndex(next); setCommand(history[next] ?? ""); }
            else if (event.key === "ArrowDown" && historyIndex >= 0) { event.preventDefault(); const next = historyIndex - 1; setHistoryIndex(next); setCommand(next >= 0 ? history[next] ?? "" : ""); }
          }}
          placeholder={t("commandPanel.placeholder")}
          aria-label={t("commandPanel.placeholder")}
          disabled={!cwd}
        />
        {suggestions.length ? <div id="command-history-suggestions" className={styles.commandSuggestions} role="listbox" aria-label={t("commandPanel.historyMatches")}>
          <div className={styles.commandSuggestionsHeader}><span>{t("commandPanel.historyMatches")}</span><span>{t("commandPanel.historyHint")}</span></div>
          {suggestions.map((suggestion, index) => <button key={suggestion} id={`command-history-option-${index}`} type="button" role="option" aria-selected={suggestionIndex === index} data-active={suggestionIndex === index || undefined} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => chooseSuggestion(suggestion)}><AliIcon name="history" size={12} /><code>{suggestion}</code></button>)}
        </div> : null}
      </div>
      <button className={styles.terminalRunButton} type="button" onClick={() => run()} disabled={!cwd || submitting || !command.trim()}><AliIcon name="play" size={11} /><span>{t("commandPanel.run")}</span></button>
      <div className={styles.terminalComposerMeta}><span className={styles.commandLimit}>{t("commandPanel.limit")}</span></div>
    </footer>
  </div>;
}

function compactCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function countMatches(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index >= 0) { count += 1; index = value.indexOf(needle, index + Math.max(1, needle.length)); }
  return count;
}

function highlightText(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match = lowerText.indexOf(lowerNeedle);
  while (match >= 0) {
    if (match > cursor) parts.push(text.slice(cursor, match));
    parts.push(<mark key={`${match}:${parts.length}`}>{text.slice(match, match + needle.length)}</mark>);
    cursor = match + needle.length;
    match = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
