import { createConnection, type Socket } from "node:net";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export type TouchPhase = "down" | "move" | "up";

/** Dedicated, caller-forwarded uitest control socket. Never replays a mutation. */
export class GestureChannel {
  private socket?: Socket;
  private pending?: Pending;
  private buffer = "";
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly port: number, private readonly timeoutMs = 1000) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local forwarding port");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid gesture timeout");
  }

  async connect(): Promise<void> {
    if (this.closed || this.socket) throw new Error("Gesture channel cannot be reopened");
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = createConnection({ host: "127.0.0.1", port: this.port });
      const timer = setTimeout(() => { const error = new Error("Gesture connection timed out"); this.fail(error); reject(error); }, this.timeoutMs);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.receive(chunk));
      socket.on("error", error => { clearTimeout(timer); this.fail(error); reject(error); });
      socket.on("close", () => { clearTimeout(timer); const error = new Error("Gesture connection closed; input state may be uncertain"); this.fail(error); reject(error); });
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
    });
  }

  touch(phase: TouchPhase, x: number, y: number): Promise<unknown> {
    if (!["down", "move", "up"].includes(phase) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      return Promise.reject(new Error("Invalid touch event"));
    }
    const api = { down: "touchDown", move: "touchMove", up: "touchUp" }[phase];
    const payload = JSON.stringify({ module: "com.ohos.devicetest.hypiumApiHelper", method: "Gestures", params: { api, args: { x, y } } });
    const next = this.tail.then(() => this.request(payload));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private request(payload: string): Promise<unknown> {
    if (this.closed || !this.socket || this.socket.destroyed) return Promise.reject(new Error("Gesture channel unavailable"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Gesture acknowledgement timed out; input was not replayed")), this.timeoutMs);
      this.pending = { resolve, reject, timer };
      this.socket!.write(payload, error => { if (error) this.fail(error); });
    });
  }

  // TCP data events are not message boundaries. Split/coalesced JSON and UTF-8
  // must be handled without accepting a partial acknowledgement.
  private receive(chunk: string): void {
    if (this.closed) return;
    if (!this.pending) return this.fail(new Error("Unsolicited gesture reply"));
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 64 * 1024) return this.fail(new Error("Oversized gesture reply"));
    const source = this.buffer.trimStart();
    if (!source) { this.buffer = ""; return; }
    if (source[0] !== "{") return this.fail(new Error("Unsupported gesture reply framing"));
    let depth = 0, quoted = false, escape = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) { if (escape) escape = false; else if (char === "\\") escape = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      if (depth !== 0) continue;
      if (!this.pending || source.slice(index + 1).trim()) return this.fail(new Error("Unexpected gesture reply; channel closed"));
      let value: Record<string, unknown>;
      try { value = JSON.parse(source.slice(0, index + 1)); }
      catch { return this.fail(new Error("Malformed gesture reply")); }
      if (Object.hasOwn(value, "exception")) return this.fail(new Error(`Gesture rejected: ${JSON.stringify(value.exception)}`));
      const pending = this.pending; this.pending = undefined; this.buffer = "";
      clearTimeout(pending.timer); pending.resolve(value); return;
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.socket?.destroy();
  }

  close(): void { this.fail(new Error("Gesture channel disposed")); }
}
