import { parseUpdateSource, type DesktopUpdateSource } from "./update-source.js";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "./logger.js";
import type { DesktopReleaseAudience } from "./release-audience.js";

export type DesktopUpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  unsupportedReason?: "alpha" | "installer-required";
  currentVersion: string;
  audience: DesktopReleaseAudience;
  source?: DesktopUpdateSource;
  latestVersion?: string;
  availableVersion?: string;
  releaseNotes?: string;
  progressPercent?: number;
  bytesPerSecond?: number;
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
}

export type DesktopUpdateListener = (state: Readonly<DesktopUpdateState>) => void;

export interface DesktopUpdateControllerOptions {
  audience?: DesktopReleaseAudience;
  source?: DesktopUpdateSource;
  prepareCheck?: () => Promise<boolean>;
  validateUpdateInfo?: (info: unknown) => void;
}

function normalizedVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^v/i, "");
  return trimmed || undefined;
}

function normalizedError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const MAX_RELEASE_NOTES_LENGTH = 24_000;

function normalizedReleaseNotes(value: unknown): string | undefined {
  const notes = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((entry) => {
            if (!entry || typeof entry !== "object") return "";
            const record = entry as { version?: unknown; note?: unknown };
            const note = typeof record.note === "string" ? record.note.trim() : "";
            if (!note) return "";
            const version = normalizedVersion(record.version);
            return version ? `### v${version}\n\n${note}` : note;
          })
          .filter(Boolean)
          .join("\n\n")
      : "";
  const trimmed = notes.trim();
  return trimmed ? trimmed.slice(0, MAX_RELEASE_NOTES_LENGTH) : undefined;
}

function normalizedProgressValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export class DesktopUpdateController {
  private state: DesktopUpdateState;
  private readonly listeners = new Set<DesktopUpdateListener>();
  private checkPromise: Promise<void> | undefined;
  private downloadPromise: Promise<void> | undefined;

  constructor(
    private readonly updater: AppUpdater | null,
    currentVersion: string,
    private readonly logger: Logger,
    private readonly options: DesktopUpdateControllerOptions = {},
  ) {
    // Alpha builds never initialize an updater, including over existing beta installs.
    const isAlpha = /^(?:v)?\d+\.\d+\.\d+-alpha\.\d+$/.test(currentVersion.trim());
    if (isAlpha) {
      this.updater = null;
      updater = null;
    }
    const audience = options.audience ?? "stable";
    this.state = {
      status: updater ? "idle" : "unsupported",
      ...(!updater ? { unsupportedReason: isAlpha ? "alpha" as const : "installer-required" as const } : {}),
      currentVersion: normalizedVersion(currentVersion) ?? currentVersion,
      audience,
      source: options.source ?? "github",
    };

    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = audience === "preview";
    updater.logger = logger;

    updater.on("checking-for-update", () => {
      this.publish({ status: "checking" });
    });
    updater.on("update-not-available", () => {
      this.publish({ status: "up-to-date" });
    });
    updater.on("update-available", (info) => {
      try { this.options.validateUpdateInfo?.(info); } catch (error) { this.fail(error); return; }
      const availableVersion = normalizedVersion(info.version);
      const releaseNotes = normalizedReleaseNotes(info.releaseNotes);
      this.publish({
        status: "available",
        ...(availableVersion ? { availableVersion } : {}),
        ...(releaseNotes ? { releaseNotes } : {}),
      });
    });
    updater.on("download-progress", (progress) => {
      const bytesPerSecond = normalizedProgressValue(progress.bytesPerSecond);
      const transferredBytes = normalizedProgressValue(progress.transferred);
      const totalBytes = normalizedProgressValue(progress.total);
      this.publish({
        status: "downloading",
        progressPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
        ...(transferredBytes === undefined ? {} : { transferredBytes }),
        ...(totalBytes === undefined ? {} : { totalBytes }),
      });
    });
    updater.on("update-downloaded", (info) => {
      try { this.options.validateUpdateInfo?.(info); } catch (error) { this.fail(error); return; }
      const availableVersion = normalizedVersion(info.version);
      const releaseNotes = normalizedReleaseNotes(info.releaseNotes);
      this.publish({
        status: "downloaded",
        ...(availableVersion ? { availableVersion } : {}),
        ...(releaseNotes ? { releaseNotes } : {}),
        progressPercent: 100,
      });
    });
    updater.on("update-cancelled", (info) => {
      const availableVersion = normalizedVersion(info.version);
      this.publish({
        status: "available",
        ...(availableVersion ? { availableVersion } : {}),
      });
    });
    updater.on("error", (error) => {
      this.fail(error);
    });
  }

  getState(): Readonly<DesktopUpdateState> {
    return { ...this.state };
  }

  subscribe(listener: DesktopUpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  selectSource(source: unknown, persist: (source: DesktopUpdateSource) => void): void {
    const next = parseUpdateSource(source);
    if (!this.updater) throw new Error("Updates are unsupported");
    if (this.checkPromise || this.downloadPromise) throw new Error("Wait for the current update operation to finish");
    if (next === this.state.source) return;
    persist(next);
    this.state = { status: "idle", currentVersion: this.state.currentVersion, audience: this.state.audience, source: next };
    this.publish({ status: "idle" });
  }

  setLatestVersion(version: string | undefined): void {
    if (version) this.state.latestVersion = version;
    else delete this.state.latestVersion;
  }

  async checkForUpdates(): Promise<void> {
    if (!this.updater || this.downloadPromise) return;
    return this.checkLatestVersion();
  }

  private async checkLatestVersion(): Promise<void> {
    if (this.checkPromise) return this.checkPromise;

    delete this.state.latestVersion;
    this.publish({ status: "checking" });
    this.checkPromise = Promise.resolve()
      .then(async () => {
        if (this.options.prepareCheck && !await this.options.prepareCheck()) {
          this.publish({ status: "up-to-date" });
          return;
        }
        await this.updater?.checkForUpdates();
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.checkPromise = undefined;
      });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise;
    if (!this.updater || !["available", "downloaded"].includes(this.state.status)) return;

    // The startup notification (or a downloaded installer) may be hours old.
    // Resolve the channel again before using electron-updater's download target.
    this.downloadPromise = Promise.resolve()
      .then(async () => {
        await this.checkLatestVersion();
        if (this.state.status !== "available") return;
        this.publish({ status: "downloading", progressPercent: 0 });
        // Reusing the SDK's download path also validates a cached installer when
        // the version is unchanged; a newer target replaces the old cache.
        await this.updater?.downloadUpdate();
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.downloadPromise = undefined;
      });
    return this.downloadPromise;
  }

  async prepareForInstall(): Promise<boolean> {
    if (this.state.status !== "downloaded") return false;
    await this.downloadUpdate();
    return this.getState().status === "downloaded";
  }

  quitAndInstall(silent = false): boolean {
    if (!this.updater || this.state.status !== "downloaded") return false;
    this.updater.quitAndInstall(silent, true);
    return true;
  }

  private fail(error: unknown): void {
    const message = normalizedError(error);
    this.logger.error("Desktop update failed", error);
    this.publish({ status: "error", error: message });
  }

  private publish(next: Omit<DesktopUpdateState, "currentVersion" | "audience">): void {
    const keepsAvailableVersion = next.status === "available"
      || next.status === "downloading"
      || next.status === "downloaded";
    const availableVersion = next.availableVersion
      ?? (keepsAvailableVersion ? this.state.availableVersion : undefined);
    const releaseNotes = next.releaseNotes
      ?? (keepsAvailableVersion ? this.state.releaseNotes : undefined);
    this.state = {
      status: next.status,
      currentVersion: this.state.currentVersion,
      audience: this.state.audience,
      ...(this.state.source ? { source: this.state.source } : {}),
      ...(this.state.latestVersion ? { latestVersion: this.state.latestVersion } : {}),
      ...(availableVersion ? { availableVersion } : {}),
      ...(releaseNotes ? { releaseNotes } : {}),
      ...(next.progressPercent === undefined ? {} : { progressPercent: next.progressPercent }),
      ...(next.bytesPerSecond === undefined ? {} : { bytesPerSecond: next.bytesPerSecond }),
      ...(next.transferredBytes === undefined ? {} : { transferredBytes: next.transferredBytes }),
      ...(next.totalBytes === undefined ? {} : { totalBytes: next.totalBytes }),
      ...(next.error ? { error: next.error } : {}),
    };
    const snapshot = this.getState();
    this.logger.info("Desktop update state changed", snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}
