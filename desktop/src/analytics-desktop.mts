import { randomUUID } from "node:crypto";
import { app, powerMonitor, safeStorage, type BrowserWindow } from "electron";
import {
  AnalyticsStore,
  analyticsDirectory,
  readAnalyticsConfig,
  analyticsLaunchReason,
} from "./analytics-store.mjs";
import { AnalyticsUploader } from "./analytics-uploader.mjs";

export class DesktopAnalytics {
  private interval: ReturnType<typeof setInterval>;
  private locked = false;
  private suspended = false;
  private lastTick = performance.now();
  private lastWall = Date.now();
  private start = Date.now();
  private runtime = 0;
  private ranges: { start_at: string; end_at: string }[] = [];
  private minute = 0;
  private offset = 0;
  private lastOpened = 0;
  private readonly handlers: [string, () => void][];
  constructor(
    readonly store: AnalyticsStore,
    readonly uploader: AnalyticsUploader,
    private readonly window: () => BrowserWindow | null,
  ) {
    store.set("app_launch_id", randomUUID());
    store.set("app_version", app.getVersion());
    let legacyLoginItem: boolean | undefined;
    try {
      const login = app.getLoginItemSettings({
        path: process.execPath,
        args: [],
      });
      legacyLoginItem =
        login.openAtLogin && login.executableWillLaunchAtLogin !== false;
    } catch {
      /* Unknown startup origin must not inflate manual opens. */
    }
    const reason = analyticsLaunchReason(process.argv, legacyLoginItem);
    if (reason === "unknown")
      store.set("health_codes", ["STARTUP_ORIGIN_UNKNOWN"]);
    store.record(
      "desktop.started",
      "launch:" + store.get<string>("app_launch_id"),
      { reason },
      uploader.now(),
    );
    if (reason === "manual") this.opened("manual_launch");
    this.handlers = [
      [
        "lock-screen",
        () => {
          this.tick();
          this.flushActivity();
          this.locked = true;
        },
      ],
      [
        "unlock-screen",
        () => {
          this.tick();
          this.flushActivity();
          this.locked = false;
          this.resetClock();
        },
      ],
      [
        "suspend",
        () => {
          this.tick();
          this.flushActivity();
          this.suspended = true;
        },
      ],
      [
        "resume",
        () => {
          this.suspended = false;
          this.resetClock();
          this.uploader.reconnect();
        },
      ],
    ];
    this.handlers = this.handlers.map(([event, handler]) => [
      event,
      () => {
        try {
          handler();
        } catch {
          /* telemetry never blocks a power event */
        }
      },
    ]);
    for (const [event, handler] of this.handlers)
      powerMonitor.on(event as "suspend", handler);
    this.interval = setInterval(() => {
      try {
        this.tick();
        if (Date.now() - this.start >= 60000) this.flushActivity();
      } catch {
        try {
          store.set("health_codes", ["ACTIVITY_WRITE_FAILED"]);
        } catch {
          /* disk unavailable */
        }
      }
    }, 5000);
    this.interval.unref();
    uploader.start();
  }
  private resetClock(): void {
    this.lastTick = performance.now();
    this.lastWall = Date.now();
    this.start = Date.now();
    this.runtime = 0;
    this.ranges = [];
  }
  private corrected(time: number): string {
    return new Date(time + this.offset).toISOString();
  }
  private tick(): void {
    const mono = performance.now(),
      wall = Date.now(),
      elapsed = mono - this.lastTick,
      gap = wall - this.lastWall,
      w = this.window();
    if (wall - this.start > 60000 && this.lastWall > this.start)
      this.flushActivity(this.lastWall);
    const nextOffset = this.store.get<number>("clock_offset_ms") ?? 0;
    if (nextOffset !== this.offset) {
      this.flushActivity(this.lastWall);
      this.offset = nextOffset;
      this.start = this.lastWall;
    }
    if (
      !this.suspended &&
      elapsed >= 0 &&
      elapsed <= 7500 &&
      gap >= 0 &&
      Math.abs(gap - elapsed) < 1000
    ) {
      this.runtime += gap;
      if (
        !this.locked &&
        w &&
        !w.isDestroyed() &&
        w.isVisible() &&
        w.isFocused() &&
        powerMonitor.getSystemIdleTime() < 60
      ) {
        const start = this.corrected(this.lastWall),
          end = this.corrected(wall),
          prev = this.ranges.at(-1);
        if (prev?.end_at === start) prev.end_at = end;
        else this.ranges.push({ start_at: start, end_at: end });
      }
    } else if (!this.suspended) {
      this.flushActivity(this.lastWall);
      this.start = wall;
      this.store.set("health_codes", ["ACTIVITY_CLOCK_GAP"]);
    }
    this.lastTick = mono;
    this.lastWall = wall;
  }
  private flushActivity(end = Date.now()): void {
    if (end > this.start && end - this.start <= 60000 && this.runtime > 0)
      this.store.record(
        "desktop.activity",
        "activity:" +
          this.store.get<string>("app_launch_id") +
          ":" +
          this.minute++,
        {
          start_at: this.corrected(this.start),
          end_at: this.corrected(end),
          runtime_ms: String(
            Math.min(Math.round(this.runtime), end - this.start),
          ),
          active_ranges: this.ranges,
          sample_interval_ms: 5000,
          time_quality: this.store.get<string>("clock_sync_at")
            ? "synchronized"
            : "local_only",
        },
        this.corrected(end),
      );
    this.start = end;
    this.runtime = 0;
    this.ranges = [];
  }
  opened(reason: "manual_launch" | "shortcut" | "tray" | "menu"): void {
    if (Date.now() - this.lastOpened < 2000) return;
    this.lastOpened = Date.now();
    const id = randomUUID();
    try {
      this.store.record(
        "desktop.opened",
        "open:" + id,
        { activation_id: id, reason },
        this.uploader.now(),
      );
    } catch {
      /* analytics must not block opening the app */
    }
  }
  stop(): void {
    clearInterval(this.interval);
    for (const [event, handler] of this.handlers)
      powerMonitor.removeListener(event as "suspend", handler);
    try {
      this.tick();
      this.flushActivity();
    } catch {
      /* Never block app shutdown. */
    } finally {
      this.uploader.stop();
    }
  }
}
export async function startDesktopAnalytics(
  window: () => BrowserWindow | null,
): Promise<DesktopAnalytics | undefined> {
  const config = readAnalyticsConfig(),
    directory = analyticsDirectory();
  if (!config || !directory) return undefined;
  let store: AnalyticsStore | undefined;
  try {
    store = new AnalyticsStore(directory);
    store.set("app_version", app.getVersion());
    return new DesktopAnalytics(
      store,
      await AnalyticsUploader.create(store, config, safeStorage),
      window,
    );
  } catch {
    try {
      store?.set("last_error", "COLLECTOR_START_FAILED");
      store?.set("upload_paused", true);
      store?.close();
    } catch {
      /* disk unavailable */
    }
    return undefined;
  }
}
