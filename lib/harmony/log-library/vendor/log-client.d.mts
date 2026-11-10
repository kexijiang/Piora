export function libraryUrl(sessionId: string, path: string, params?: Record<string, string | number | boolean>): string;
export function libraryRequest<T = unknown>(sessionId: string, path: string, options?: Omit<RequestInit, "body"> & {
  params?: Record<string, string | number | boolean>;
  body?: unknown;
  rawBody?: BodyInit;
}): Promise<T>;
export function importLogFile(file: File, sessionId: string, options?: {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number, phase: string) => void;
  sourceKind?: "import" | "realtime";
  snapshot?: Record<string, unknown>;
  groupId?: string;
  encoding?: string;
}): Promise<{ id: string; name: string }>;
export function logAnalysisPrompt(file: { name: string; analysisPath?: string; manifestPath?: string }, row?: { sourceLine?: number; raw?: string; message?: string }, filters?: Record<string, unknown>): string;
export function selectionAnalysisPrompt(value: { manifestPath: string }): string;
export const directoryAnalysisPrompt: typeof selectionAnalysisPrompt;
