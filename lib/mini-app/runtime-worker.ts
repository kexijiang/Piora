import { MiniAppVm, type MiniAppVmRequest } from "./vm";
import { boundedJson } from "./json";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";

const scope = self as unknown as {
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  postMessage(value: unknown): void;
};
let runtime: MiniAppVm | undefined;
let epoch: string | undefined;
let sequence = 0;
let initializing = false;
let ended = false;

scope.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message !== "object" || ended) return;
  if (message.type === "boot") {
    if (epoch || initializing || typeof message.epoch !== "string" || message.epoch.length > 128
      || !(message.wasm instanceof ArrayBuffer) || message.wasm.byteLength > 8 * 1024 * 1024
      || typeof message.program !== "string" || message.program.length > MINI_APP_LIMITS.programBytes) return;
    epoch = message.epoch;
    initializing = true;
    void MiniAppVm.create(new Uint8Array(message.wasm), message.program).then(created => {
      if (ended) { created.dispose(); return; }
      runtime = created;
      scope.postMessage({ type: "ready", epoch, seq: 0 });
    }).catch(() => {
      ended = true;
      scope.postMessage({ type: "error", epoch, seq: 0, code: "INITIALIZATION" });
    }).finally(() => { initializing = false; });
    return;
  }
  if (!runtime || message.epoch !== epoch || message.type !== "run"
    || !Number.isSafeInteger(message.seq) || message.seq !== sequence + 1) return;
  sequence = message.seq;
  try {
    if (typeof message.request !== "string" || message.request.length > MINI_APP_LIMITS.replyBytes) throw new MiniAppError("LIMIT", "Request is too large");
    const request = JSON.parse(message.request) as MiniAppVmRequest;
    boundedJson(request, MINI_APP_LIMITS.replyBytes);
    const reply = runtime.run(request);
    scope.postMessage({ type: "result", epoch, seq: sequence, reply: boundedJson(reply, MINI_APP_LIMITS.replyBytes) });
  } catch (error) {
    const code = error instanceof MiniAppError ? error.code : "EXECUTION";
    // An interrupted run may have partially executed. Recovery always starts a new VM.
    ended = true;
    runtime.dispose(); runtime = undefined;
    scope.postMessage({ type: "error", epoch, seq: sequence, code });
  }
});
