import type { DesktopUpdateController } from "./app-updater.js";

export interface UpdateSchedule {
  enabled: boolean;
  time: string;
  lastCompletedDay?: string;
}

export function parseUpdateSchedule(value: unknown): UpdateSchedule {
  if (!value || typeof value !== "object") throw new Error("Invalid update schedule");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || typeof input.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    throw new Error("Expected an enabled switch and a local time in HH:mm format");
  }
  return { enabled: input.enabled, time: input.time,
    ...(typeof input.lastCompletedDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.lastCompletedDay)
      ? { lastCompletedDay: input.lastCompletedDay } : {}) };
}

export function localUpdateDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Main-process scheduler: survives hidden/minimized renderers and retries after sleep. */
export class ScheduledDesktopUpdater {
  private busy = false;
  private retryAt = 0;
  private pendingDay: string | undefined;
  private configuration = "";
  constructor(private readonly options: {
    controller: DesktopUpdateController;
    read: () => UpdateSchedule;
    complete: (day: string) => void;
    canInstall: () => Promise<boolean>;
    install: () => Promise<boolean>;
    onError: (error: unknown) => void;
  }) {}

  async tick(now = new Date()): Promise<void> {
    const schedule = this.options.read();
    const configuration = `${schedule.enabled}:${schedule.time}`;
    if (this.configuration !== configuration) {
      this.configuration = configuration;
      this.pendingDay = undefined;
      this.retryAt = 0;
    }
    if (!schedule.enabled) { this.pendingDay = undefined; return; }
    if (this.busy || now.getTime() < this.retryAt) return;
    const day = localUpdateDay(now);
    const [hour = 3, minute = 0] = schedule.time.split(":").map(Number);
    if (!this.pendingDay && (schedule.lastCompletedDay === day || now.getHours() * 60 + now.getMinutes() < hour * 60 + minute)) return;
    this.busy = true;
    this.pendingDay ??= day;
    const stillEnabled = () => this.options.read().enabled && this.options.read().time === schedule.time;
    try {
      const controller = this.options.controller;
      if (controller.getState().status === "unsupported") return;
      if (!["available", "downloading", "downloaded"].includes(controller.getState().status)) await controller.checkForUpdates();
      if (!stillEnabled()) return;
      if (controller.getState().status === "available") await controller.downloadUpdate();
      if (!stillEnabled()) return;
      const status = controller.getState().status;
      if (status === "error") throw new Error(controller.getState().error ?? "Update failed");
      if (status === "downloaded") {
        if (!await this.options.canInstall() || !stillEnabled()) return;
        if (!await this.options.install()) return;
      } else if (status !== "up-to-date") return;
      this.options.complete(day);
      this.pendingDay = undefined;
    } catch (error) {
      this.retryAt = now.getTime() + 15 * 60_000;
      this.options.onError(error);
    } finally { this.busy = false; }
  }
}
