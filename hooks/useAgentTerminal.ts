"use client";
import { useEffect, useState } from "react";
import { restoreAgentTerminal, downgradeUnconfirmedRunning, type AgentTerminalCommand } from "@/lib/agent-terminal";

export function useAgentTerminal(sessionId?: string | null) {
  const [state, setState] = useState<{ id: string; commands: AgentTerminalCommand[]; error: string | null }>({ id: "", commands: [], error: null });
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let history: AgentTerminalCommand[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const fetchJson = async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (document.hidden) { timer = setTimeout(refresh, 1000); return; }
      try {
        const live = await fetchJson(`/api/agent/${encodeURIComponent(sessionId)}/commands`);
        if (controller.signal.aborted) return;
        const liveCommands = (live.commands ?? []) as AgentTerminalCommand[];
        const liveIds = new Set(liveCommands.map((item) => item.id));
        const merged = new Map(history.map((item) => [item.id, item]));
        for (const item of liveCommands) merged.set(item.id, item);
        // Only a successful live read proves a restored running entry ended.
        const commands = downgradeUnconfirmedRunning([...merged.values()], liveIds);
        setState({ id: sessionId, commands: commands.slice(-60), error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState((current) => ({ id: sessionId, commands: current.id === sessionId ? current.commands : history, error: String(error) }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
      }
    };
    void fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=true&deferMedia=true`).then((data) => {
      history = restoreAgentTerminal(data.context?.messages);
    }).catch(() => undefined).finally(() => { if (!controller.signal.aborted) void refresh(); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  return state.id === sessionId ? state : { commands: [], error: null };
}
