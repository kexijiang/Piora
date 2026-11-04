"use client";
import { CommandExecutionCard } from "./CommandExecutionView";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NestedCallsSnapshot, NestedToolCallsStore } from "@/lib/nested-tool-calls";

export const NestedToolCallsContext = createContext<NestedToolCallsStore | null>(null);
const empty = () => undefined;
export function useNestedToolCalls(id: string, saved?: NestedCallsSnapshot): NestedCallsSnapshot | undefined {
  const store = useContext(NestedToolCallsContext);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(id, listener) ?? (() => {}), [store, id]);
  const snapshot = useCallback(() => store?.getSnapshot(id), [store, id]);
  const live = useSyncExternalStore(subscribe, snapshot, empty);
  if (!saved || !live) return saved ?? live;
  return { ...saved, calls: saved.calls.map(call => {
    const preview = live.calls.find(item => item.id === call.id);
    return preview ? { ...preview, ...call } : call;
  }) };
}

export function NestedToolCalls({ snapshot }: { snapshot: NestedCallsSnapshot }) {
  const { t } = useI18n();
  const ids = new Set(snapshot.calls.map(call => call.id));
  return <div className="nested-tool-calls">
    <p>{t("nestedCalls.summaryOnly")}</p>
    {!snapshot.complete ? <p role="status">{t("nestedCalls.incomplete")}</p> : null}
    <ul aria-label={t("nestedCalls.title")}>
      {snapshot.calls.map(call => {
        let depth = 0, parent = call.id;
        while (parent.includes("/")) { parent = parent.slice(0, parent.lastIndexOf("/")); if (ids.has(parent)) depth++; }
        return <li key={call.id} style={{ marginInlineStart: Math.min(depth, 6) * 12 }}>
          <div><code>{call.name}</code> <span className={`chat-disclosure-status is-${call.status === "ok" ? "success" : call.status}`}>
            {t(call.status === "running" ? "command.status.running" : call.status === "ok" ? "command.status.success" : call.status === "error" ? "command.status.failed" : "nestedCalls.unfinished")}
          </span>{call.durationMs !== undefined ? <span> · {(call.durationMs / 1000).toFixed(1)}s</span> : null}</div>
          {call.command !== undefined ? <CommandExecutionCard data={{
            id: call.id, toolName: call.name, command: call.command,
            output: call.output ?? "", truncated: call.outputTruncated === true,
            status: call.status === "running" ? "running" : call.status === "ok" ? "success" : call.status === "unfinished" ? "cancelled" : "failed",
            isStreaming: call.status === "running",
            duration: call.durationMs !== undefined ? call.durationMs / 1000 : undefined,
          }} /> : call.error ? <pre>{call.error}</pre> : null}
          {call.argumentsBytes !== undefined ? <small>{t("nestedCalls.omittedArguments")}</small> : null}
        </li>;
      })}
    </ul>
  </div>;
}
