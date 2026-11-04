import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export type LogLevel = "error" | "warn" | "info" | "debug";
export interface LogSettings { directory: string; level: LogLevel; maxSizeMiB: number; backups: number }
export interface RuntimeLogInfo { filePath: string; fileLoggingAvailable: boolean; settings: LogSettings; defaultDirectory: string }
const LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];
function validate(input: unknown): LogSettings {
  const value = input as LogSettings;
  if (!value || typeof value.directory !== "string" || !isAbsolute(value.directory) || value.directory.includes("\0") || !LEVELS.includes(value.level)
    || !Number.isInteger(value.maxSizeMiB) || value.maxSizeMiB < 1 || value.maxSizeMiB > 100
    || !Number.isInteger(value.backups) || value.backups < 1 || value.backups > 20) throw new Error("Invalid log settings (size: 1–100 MiB; backups: 1–20; absolute directory required)");
  return { directory: value.directory, level: value.level, maxSizeMiB: value.maxSizeMiB, backups: value.backups };
}

function formatDetails(details: unknown): string {
  if (details === undefined) return "";
  try {
    const seen = new WeakSet<object>();
    return ` ${JSON.stringify(details, (_key, value: unknown) => {
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
        if (value instanceof Error) return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause };
      }
      return value;
    })}`;
  } catch {
    return ` ${String(details)}`;
  }
}

export class FileLogger implements Logger {
  filePath: string;
  private settings: LogSettings;
  private readonly settingsPath: string;
  readonly defaultDirectory: string;

  getState(): RuntimeLogInfo {
    return { filePath: this.filePath, fileLoggingAvailable: this.fileLoggingAvailable, settings: { ...this.settings }, defaultDirectory: this.defaultDirectory };
  }

  configure(input: unknown): RuntimeLogInfo {
    const next = validate(input);
    const target = join(next.directory, "piora.log");
    mkdirSync(next.directory, { recursive: true });
    appendFileSync(target, "", "utf8");
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), "utf8");
      renameSync(temporary, this.settingsPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.settings = next;
    this.filePath = target;
    this.fileLoggingAvailable = true;
    this.debug("Runtime log configuration applied", { maxSizeMiB: next.maxSizeMiB, backups: next.backups });
    return this.getState();
  }

  debug(message: string, details?: unknown): void { this.write("DEBUG", message, details); }
  fileLoggingAvailable = false;

  constructor(userDataDirectory: string, fallbackDirectory = join(tmpdir(), "Piora", "logs")) {
    this.defaultDirectory = join(userDataDirectory, "logs");
    this.settingsPath = join(userDataDirectory, "runtime-log-settings.json");
    this.settings = { directory: this.defaultDirectory, level: "info", maxSizeMiB: 5, backups: 1 };
    try { this.settings = validate(JSON.parse(readFileSync(this.settingsPath, "utf8"))); } catch { /* Missing or invalid settings use defaults. */ }
    const logDirectory = this.settings.directory;
    this.filePath = join(logDirectory, "piora.log");
    try {
      mkdirSync(logDirectory, { recursive: true });
      appendFileSync(this.filePath, "", "utf8");
      this.fileLoggingAvailable = true;
    } catch (error) {
      this.filePath = join(fallbackDirectory, `piora-startup-${process.pid}.log`);
      try {
        mkdirSync(fallbackDirectory, { recursive: true });
        appendFileSync(this.filePath, "", "utf8");
        this.fileLoggingAvailable = true;
      } catch { /* Console remains available if neither directory is writable. */ }
      this.warn("Default desktop log is unavailable; using fallback log", { logDirectory, fallback: this.filePath, error });
    }
  }

  info(message: string, details?: unknown): void {
    this.write("INFO", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("WARN", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("ERROR", message, details);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath) || statSync(this.filePath).size < this.settings.maxSizeMiB * 1024 * 1024) {
      return;
    }

    // Only remove numeric backups belonging to this exact log file.
    for (const name of readdirSync(dirname(this.filePath))) {
      const suffix = name.slice(basename(this.filePath).length);
      if (name.startsWith(basename(this.filePath)) && /^\.[1-9]\d*$/.test(suffix) && Number(suffix.slice(1)) >= this.settings.backups) unlinkSync(join(dirname(this.filePath), name));
    }
    for (let index = this.settings.backups - 1; index >= 1; index--) {
      if (existsSync(`${this.filePath}.${index}`)) renameSync(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }

  private write(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, details?: unknown): void {
    if (LEVELS.indexOf(level.toLowerCase() as LogLevel) > LEVELS.indexOf(this.settings.level)) return;
    const line = `${new Date().toISOString()} [${level}] ${message}${formatDetails(details)}\n`;

    try {
      this.rotateIfNeeded();
      appendFileSync(this.filePath, line, "utf8");
      this.fileLoggingAvailable = true;
    } catch (error) {
      this.fileLoggingAvailable = false;
      // Logging must never take the desktop application down.
      try { console.error("Unable to write desktop log", error); } catch { /* A detached console may also be unavailable. */ }
    }

    const sink = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    try { sink(line.trimEnd()); } catch { /* Closed stdout/stderr must not prevent startup. */ }
  }
}
