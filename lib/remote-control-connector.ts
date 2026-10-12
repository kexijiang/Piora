import { getGlobalDispatcher, WebSocket } from "undici";
import type { SessionCommandEvent } from "./session-message-types";

interface ConnectorSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface RemoteConnectorStatus {
  enabled: boolean;
  state: "disabled" | "connecting" | "connected" | "backoff" | "stopped";
  urlConfigured: boolean;
  deviceId?: string;
  lastError?: string;
  reconnectAttempt: number;
  lastCursor: number;
}

declare global {
  var __pioraRemoteControlConnector: RemoteControlConnector | undefined;
}

function configuredSessionIds(): Set<string> {
  return new Set((process.env.PIORA_REMOTE_CONTROL_ALLOWED_SESSION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export class RemoteControlConnector {
  private socket: ConnectorSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private reconnectAttempt = 0;
  private state: RemoteConnectorStatus["state"] = "disabled";
  private lastError: string | undefined;
  private lastCursor = 0;
  private readonly commandSubscriptions = new Map<string, () => void>();

  constructor() {
    process.once("exit", () => this.stop());
    process.once("SIGINT", () => this.stop());
    process.once("SIGTERM", () => this.stop());
  }

  getStatus(): RemoteConnectorStatus {
    return {
      enabled: Boolean(process.env.PIORA_REMOTE_CONTROL_WS_URL && process.env.PIORA_REMOTE_CONTROL_WS_TOKEN),
      state: this.state,
      urlConfigured: Boolean(process.env.PIORA_REMOTE_CONTROL_WS_URL),
      ...(process.env.PIORA_REMOTE_CONTROL_DEVICE_ID ? { deviceId: process.env.PIORA_REMOTE_CONTROL_DEVICE_ID } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      reconnectAttempt: this.reconnectAttempt,
      lastCursor: this.lastCursor,
    };
  }

  start(): void {
    if (this.socket || this.reconnectTimer || this.state === "connected" || this.state === "connecting") return;
    const url = process.env.PIORA_REMOTE_CONTROL_WS_URL;
    const token = process.env.PIORA_REMOTE_CONTROL_WS_TOKEN;
    if (!url || !token) {
      this.state = "disabled";
      return;
    }
    this.stopped = false;
    this.connect(url, token);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const unsubscribe of this.commandSubscriptions.values()) unsubscribe();
    this.commandSubscriptions.clear();
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
    this.state = "stopped";
  }

  private connect(url: string, token: string): void {
    if (this.stopped) return;
    this.state = "connecting";
    try {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, dispatcher: getGlobalDispatcher() }) as unknown as ConnectorSocket;
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.lastError = undefined;
        this.state = "connected";
        this.send({ type: "hello", protocol: "piora.remote.v1", deviceId: process.env.PIORA_REMOTE_CONTROL_DEVICE_ID ?? "piora", lastCursor: this.lastCursor });
      });
      socket.addEventListener("message", (event: unknown) => {
        const data = event && typeof event === "object" && "data" in event ? (event as { data?: unknown }).data : event;
        void this.handleMessage(data);
      });
      socket.addEventListener("error", () => {
        this.lastError = "remote connector socket error";
      });
      socket.addEventListener("close", () => {
        this.socket = undefined;
        if (!this.stopped) this.scheduleReconnect(url, token);
      });
    } catch {
      this.lastError = "remote connector could not open a socket";
      this.scheduleReconnect(url, token);
    }
  }

  private scheduleReconnect(url: string, token: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.state = "backoff";
    this.reconnectAttempt += 1;
    const base = Math.min(60_000, 500 * (2 ** Math.min(8, this.reconnectAttempt - 1)));
    const delay = Math.floor(base * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(url, token);
    }, delay);
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try { this.socket.send(JSON.stringify(payload)); } catch { /* reconnect path owns recovery */ }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let parsed: unknown;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw instanceof ArrayBuffer ? JSON.parse(new TextDecoder().decode(raw)) : JSON.parse(String(raw)); }
    catch { this.send({ type: "command.rejected", code: "INVALID_MESSAGE" }); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.send({ type: "command.rejected", code: "INVALID_MESSAGE" });
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type !== "session.message" || typeof message.commandId !== "string" || typeof message.targetSessionId !== "string" || typeof message.content !== "string") {
      this.send({ type: "command.rejected", code: "INVALID_MESSAGE" });
      return;
    }
    const externalCommandId = message.commandId;
    if (!configuredSessionIds().has(message.targetSessionId)) {
      this.send({ type: "command.rejected", externalCommandId, code: "SESSION_NOT_ALLOWED" });
      return;
    }
    const { getSessionMessageRouter } = await import("./session-message-router");
    const router = getSessionMessageRouter();
    try {
      const receipt = await router.dispatchSessionMessage({
        targetSessionId: message.targetSessionId,
        content: message.content,
        delivery: message.delivery === "steer" ? "steer" : "next_turn",
        source: "remote",
        idempotencyKey: `ws:${externalCommandId}`,
        ...(typeof message.expiresAt === "number" ? { expiresAt: message.expiresAt } : {}),
      });
      this.send({ type: "command.accepted", externalCommandId, commandId: receipt.commandId, targetSessionId: receipt.sessionId, status: receipt.status });
      if (["completed", "failed", "cancelled", "expired", "interrupted"].includes(receipt.status)) return;
      this.commandSubscriptions.set(receipt.commandId, router.subscribeEvents(receipt.sessionId, (event) => {
        if (event.commandId === receipt.commandId) this.forwardCommandEvent(externalCommandId, event);
      }));
    } catch (error) {
      this.send({ type: "command.rejected", externalCommandId, code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "DISPATCH_FAILED" });
    }
  }

  private forwardCommandEvent(externalCommandId: string, event: SessionCommandEvent): void {
    this.lastCursor = Math.max(this.lastCursor, event.cursor);
    if (!event.commandId) return;
    this.send({ type: event.type.replace("_", "."), externalCommandId, commandId: event.commandId, targetSessionId: event.sessionId, runId: event.runId, status: event.status, cursor: event.cursor });
    if (["command_completed", "command_failed", "command_cancelled", "command_expired", "command_interrupted"].includes(event.type)) {
      const unsubscribe = this.commandSubscriptions.get(event.commandId);
      unsubscribe?.();
      this.commandSubscriptions.delete(event.commandId);
    }
  }
}

export function getRemoteControlConnector(): RemoteControlConnector {
  return globalThis.__pioraRemoteControlConnector ??= new RemoteControlConnector();
}

export function startRemoteControlConnector(): RemoteConnectorStatus {
  const connector = getRemoteControlConnector();
  connector.start();
  return connector.getStatus();
}

export function stopRemoteControlConnector(): void {
  globalThis.__pioraRemoteControlConnector?.stop();
}
