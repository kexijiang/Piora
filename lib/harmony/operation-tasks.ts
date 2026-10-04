import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { asHarmonyError, HarmonyError } from "./errors";

export interface HarmonyOperationTask {
  id: string;
  serial: string;
  kind: "installation" | "snapshot" | "screenshot" | "recording";
  title: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  capturedAt?: string;
  bytes?: number;
  verification?: "device-confirmed" | "double-copy-sha256" | "media-saved";
  phase?: "starting" | "recording" | "saving";
  mediaFilename?: string;
  error?: string;
  errorCode?: string;
  deviceErrorCode?: string;
  signatureRejected?: boolean;
}

type TaskInput = Pick<HarmonyOperationTask, "serial" | "kind" | "title" | "target">;
type Evidence = Pick<HarmonyOperationTask, "capturedAt" | "bytes" | "verification" | "mediaFilename">;
const SERIAL = /^[A-Za-z0-9._:\[\]-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORDS = 200;
const KINDS = ["installation", "snapshot", "screenshot", "recording"];
const validMediaFilename = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,240}\.(?:png|mp4)$/.test(value);
const active = (task: HarmonyOperationTask) => task.status === "queued" || task.status === "running";
const validTime = (value: unknown) => typeof value === "string" && value.length <= 32 && Number.isFinite(Date.parse(value));

/** Outcome journal only: targets are display metadata; leases, SQL and database paths are excluded. */
export class HarmonyOperationTasks {
  private records: HarmonyOperationTask[] = [];

  constructor(private readonly journalPath?: string, private readonly now: () => number = Date.now) {
    if (!journalPath || !existsSync(journalPath)) return;
    const file = lstatSync(journalPath);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 2 * 1024 * 1024)
      throw new HarmonyError("INVALID_RESPONSE", "Invalid operation task journal");
    const parsed: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
    if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS || new Set(parsed.map(task => task?.id)).size !== parsed.length
      || parsed.some(task => !task || typeof task.id !== "string" || !UUID.test(task.id)
      || typeof task.serial !== "string" || !SERIAL.test(task.serial) || !KINDS.includes(task.kind)
      || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(task.status)
      || typeof task.title !== "string" || task.title.length > 512 || typeof task.target !== "string" || task.target.length > 4096
      || !validTime(task.createdAt) || !validTime(task.updatedAt)))
      throw new HarmonyError("INVALID_RESPONSE", "Invalid operation task journal");
    this.records = parsed.map(task => ({ id: task.id, serial: task.serial, kind: task.kind, title: task.title, target: task.target,
      status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      ...(validTime(task.completedAt) ? { completedAt: task.completedAt } : {}),
      ...(validTime(task.capturedAt) ? { capturedAt: task.capturedAt } : {}),
      ...(Number.isSafeInteger(task.bytes) && task.bytes >= 0 ? { bytes: task.bytes } : {}),
      ...(["device-confirmed", "double-copy-sha256", "media-saved"].includes(task.verification) ? { verification: task.verification } : {}),
      ...(["starting", "recording", "saving"].includes(task.phase) ? { phase: task.phase } : {}),
      ...(validMediaFilename(task.mediaFilename) ? { mediaFilename: task.mediaFilename } : {}),
      ...(typeof task.error === "string" ? { error: task.error.slice(0, 512) } : {}),
      ...(typeof task.errorCode === "string" ? { errorCode: task.errorCode.slice(0, 64) } : {}),
      ...(typeof task.deviceErrorCode === "string" && /^\d{1,12}$/.test(task.deviceErrorCode) ? { deviceErrorCode: task.deviceErrorCode } : {}),
      ...(task.signatureRejected === true ? { signatureRejected: true } : {}),
    }));
    if (this.records.some(active)) this.commit(this.records.map(task => active(task) ? { ...task, status: "interrupted",
      updatedAt: this.timestamp(), error: "The previous process ended before confirmation. Check the device; no automatic replay." } : task));
  }

  private timestamp() { return new Date(this.now()).toISOString(); }

  private commit(records: HarmonyOperationTask[]) {
    if (this.journalPath) {
      mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
      if (existsSync(this.journalPath) && (!lstatSync(this.journalPath).isFile() || lstatSync(this.journalPath).isSymbolicLink()))
        throw new HarmonyError("INVALID_RESPONSE", "Invalid operation task journal");
      writePrivateFileAtomicSync(this.journalPath, JSON.stringify(records));
    }
    this.records = records;
  }

  private update(id: string, patch: Partial<HarmonyOperationTask>) {
    this.commit(this.records.map(task => task.id === id ? { ...task, ...patch, updatedAt: this.timestamp() } : task));
  }

  list(serial: string): HarmonyOperationTask[] {
    return this.records.filter(task => task.serial === serial).map(task => ({ ...task })).reverse();
  }

  /** A recording stays one durable task across separate start and stop requests. */
  begin(input: TaskInput): string {
    if (!SERIAL.test(input.serial) || !KINDS.includes(input.kind) || !input.title || input.title.length > 512 || !input.target || input.target.length > 4096)
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid operation task target");
    const retained = this.records.slice();
    while (retained.length >= MAX_RECORDS) {
      const oldest = retained.findIndex(task => !active(task));
      if (oldest < 0) throw new HarmonyError("DEVICE_BUSY", "Too many active operation tasks");
      retained.splice(oldest, 1);
    }
    const time = this.timestamp(), id = randomUUID();
    this.commit([...retained, { ...input, id, status: "queued", createdAt: time, updatedAt: time,
      ...(input.kind === "recording" ? { phase: "starting" as const } : {}) }]);
    return id;
  }

  started(id: string, phase?: HarmonyOperationTask["phase"]) {
    const task = this.records.find(item => item.id === id);
    if (!task || !active(task)) return;
    this.update(id, { status: "running", ...(phase ? { phase } : {}) });
  }

  complete(id: string, evidence: Evidence) {
    if (evidence.mediaFilename !== undefined && !validMediaFilename(evidence.mediaFilename))
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid saved media filename");
    this.update(id, { ...evidence, status: "completed", completedAt: this.timestamp(), error: undefined, errorCode: undefined });
  }

  failed(id: string, failure: unknown, started = true) {
    const error = asHarmonyError(failure);
    const task = this.records.find(item => item.id === id);
    if (!task || task.status === "completed") return;
    const notSent = !started || error.details?.dispatchState === "not-sent";
    const uncertainInstall = task.kind === "installation" && !notSent && ["COMMAND_ABORTED", "COMMAND_TIMEOUT", "INTERNAL_ERROR", "INVALID_RESPONSE", "DEVICE_OFFLINE", "COMMAND_OUTPUT_LIMIT"].includes(error.code);
    const uncertainMedia = (task.kind === "recording" || task.kind === "screenshot")
      && (error.code === "DEVICE_OFFLINE" || error.details?.cleanup === "uncertain"
        || (task.kind === "recording" && !notSent && error.details?.recordingStopped !== true));
    this.update(id, { status: uncertainInstall || uncertainMedia ? "interrupted" : error.code === "COMMAND_ABORTED" ? "cancelled" : "failed",
      completedAt: this.timestamp(), error: error.message.slice(0, 512), errorCode: error.code,
      ...(error.details?.reason === "signature-rejected" ? { signatureRejected: true } : {}),
      ...(typeof error.details?.deviceErrorCode === "string" && /^\d{1,12}$/.test(error.details.deviceErrorCode)
        ? { deviceErrorCode: error.details.deviceErrorCode } : {}),
    });
  }

  async track<T>(input: TaskInput, perform: (started: () => void) => Promise<T>, evidence: (result: T) => Evidence): Promise<T> {
    const id = this.begin(input);
    let started = false;
    try {
      const result = await perform(() => {
        if (started) return;
        this.started(id); started = true;
      });
      this.complete(id, evidence(result));
      return result;
    } catch (failure) {
      this.failed(id, failure, started);
      throw failure;
    }
  }
}
