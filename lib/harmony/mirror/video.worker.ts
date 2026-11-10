import { MirrorVideoEngine } from "./video-engine";
import type { MirrorWorkerCommand, MirrorWorkerEvent } from "./messages";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MirrorWorkerCommand>) => void) | null;
  postMessage(event: MirrorWorkerEvent): void;
};
let engine: MirrorVideoEngine | undefined;
scope.onmessage = ({ data }) => {
  if (data.type === "start") {
    engine?.stop();
    try {
      engine = new MirrorVideoEngine(data.canvas, data.serial, data.generation, event => scope.postMessage(event));
      engine.start();
    } catch (error) { scope.postMessage({ type: "state", state: "error", error: error instanceof Error ? error.message : String(error) }); }
  } else if (data.type === "stop") { engine?.stop(); engine = undefined; }
  else if (data.type === "reconnect") engine?.reconnect();
};
