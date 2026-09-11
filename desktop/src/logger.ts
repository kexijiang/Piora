import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

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
  readonly filePath: string;
  fileLoggingAvailable = false;

  constructor(userDataDirectory: string, fallbackDirectory = join(tmpdir(), "Piora", "logs")) {
    const logDirectory = join(userDataDirectory, "logs");
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
    if (!existsSync(this.filePath) || statSync(this.filePath).size < MAX_LOG_BYTES) {
      return;
    }

    const previousPath = `${this.filePath}.1`;
    if (existsSync(previousPath)) unlinkSync(previousPath);
    renameSync(this.filePath, previousPath);
  }

  private write(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown): void {
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
