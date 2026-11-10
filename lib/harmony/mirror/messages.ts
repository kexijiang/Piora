export interface MirrorStatistics {
  receivedFps: number;
  decodedFps: number;
  presentedFps: number;
  receiveToDrawP95Ms: number;
  drawMs: number;
  droppedFrames: number;
  decoderQueue: number;
  reconnects: number;
  decoder: "hardware-preferred" | "software-preferred" | "unspecified";
}

export type MirrorWorkerCommand =
  | { type: "start"; canvas: OffscreenCanvas; serial: string; generation: number }
  | { type: "stop" }
  | { type: "reconnect" };

export type MirrorWorkerEvent =
  | { type: "state"; state: "connecting" | "live" | "recovering" | "error"; error?: string; requestError?: unknown }
  | { type: "frame"; width: number; height: number; revision: number }
  | { type: "statistics"; statistics: MirrorStatistics };
