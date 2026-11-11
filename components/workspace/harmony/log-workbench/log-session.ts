"use client";

import { createContext } from "react";
import { importLogFile } from "@/lib/harmony/log-library/vendor/log-client.mjs";

export type LogSnapshot = { bundle: string; serial: string; filters: Record<string, unknown>; capturedAt: string; count: number; firstTimestamp?: string; lastTimestamp?: string; dropped: number; evicted: number };
export const LogSessionContext = createContext<{ sessionId?: string; onOpenLogs?: (id?: string) => void; onAnalyze?: (text: string) => void }>({});

export async function saveSessionLog(file: File, sessionId: string, snapshot: LogSnapshot, signal: AbortSignal) {
  return importLogFile(file, sessionId, { signal, sourceKind: "realtime", snapshot });
}
