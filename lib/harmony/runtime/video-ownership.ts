import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { HarmonyError } from "../errors";
import type { CommandResult } from "../command-runner";
import { acquireDeviceLock, sharedDeviceLockDirectory } from "./device-lock";
import { readBoundedRegularFile } from "./bounded-file";
import { assertUnredirectedPathSync } from "./path-safety";

type Run = (args: readonly string[], operation: string, signal?: AbortSignal, timeout?: number) => Promise<CommandResult>;
interface Record { version: 1; serial: string; hostPid: number; name: string; port: number; shared?: boolean }
const NAME = /^piora_video_[a-f0-9]{32}\.so$/;
const SOCKET = "localabstract:scrcpy_grpc_socket";
export const videoOwnershipDirectory = () => join(dirname(sharedDeviceLockDirectory()), "video");

/** A separate viewing lock: passive video never acquires the device's input lease. */
export class VideoOwnership {
  private readonly directory: string;
  private readonly lock: ReturnType<typeof acquireDeviceLock>;
  private readonly record: Record;
  private released = false;

  constructor(serial: string, name: string, port: number, private readonly run: Run, root = videoOwnershipDirectory()) {
    if (!NAME.test(name) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid video ownership identity");
    this.directory = join(root, "records");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertUnredirectedPathSync(this.directory);
    this.lock = acquireDeviceLock(serial, join(root, "locks"));
    this.record = { version: 1, serial, hostPid: process.pid, name, port };
  }

  private path(record: Record) { return join(this.directory, `${record.name}.json`); }
  private async shell(record: Record, command: string, operation: string) {
    const result = await this.run(["-t", record.serial, "shell", command], operation, undefined, 8000);
    return result.stdout.toString("utf8").replace(/\0/g, "");
  }
  private async clean(record: Record): Promise<void> {
    if (record.shared) {
      await this.cleanForward(record);
      try { unlinkSync(this.path(record)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return;
    }
    const processes = await this.shell(record, "ps -ef", "debug_video_recovery_owner");
    const matches = processes.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(fields =>
      /^\d+$/.test(fields[1]) && fields.includes(record.name) && fields.includes("--extension-name") && fields.includes("uitest"));
    if (matches.length > 1) throw new HarmonyError("DEVICE_BUSY", "Ambiguous debug video owner; reconnect after closing its mirror");
    if (matches.length === 1) await this.shell(record, `kill -9 ${Number(matches[0][1])}`, "debug_video_recovery_stop");
    // A stale forward may have been reused by another tool. Never remove it while
    // a foreign service owns the global socket, or if its serial/endpoints changed.
    let sockets = await this.shell(record, "cat /proc/net/unix", "debug_video_recovery_socket");
    for (let attempt = 0; matches.length === 1 && sockets.includes("@scrcpy_grpc_socket") && attempt < 8; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      sockets = await this.shell(record, "cat /proc/net/unix", "debug_video_recovery_socket");
    }
    if (sockets.includes("@scrcpy_grpc_socket")) throw new HarmonyError("DEVICE_BUSY", "The debug video channel is still owned by another tool", { details: { reason: "debug-video-busy" } });
    await this.cleanForward(record);
    await this.shell(record, `rm -f /data/local/tmp/${record.name} /data/local/tmp/${record.name}.log`, "debug_video_recovery_file_cleanup");
    try { unlinkSync(this.path(record)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async cleanForward(record: Record): Promise<void> {
    const forwards = await this.run(["-t", record.serial, "fport", "ls"], "debug_video_recovery_forwards", undefined, 8000);
    const ownsForward = forwards.stdout.toString("utf8").split(/\r?\n/).some(line => {
      const fields = line.trim().split(/\s+/);
      return fields.length === 4 && fields[0] === record.serial && fields[1] === `tcp:${record.port}` && fields[2] === SOCKET && fields[3] === "[Forward]";
    });
    if (ownsForward) await this.run(["-t", record.serial, "fport", "rm", `tcp:${record.port}`, SOCKET], "debug_video_recovery_forward_cleanup", undefined, 8000);
  }

  async prepare(): Promise<void> {
    for (const name of readdirSync(this.directory).filter(name => NAME.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))) {
      let record: Record;
      try {
        record = JSON.parse((await readBoundedRegularFile(join(this.directory, name), 2048)).toString("utf8"));
        if (record.version !== 1 || record.serial !== this.record.serial || `${record.name}.json` !== name || !NAME.test(record.name)
          || (record.shared !== undefined && typeof record.shared !== "boolean")
          || !Number.isInteger(record.hostPid) || record.hostPid < 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
      } catch { continue; }
      if (record.hostPid !== process.pid) {
        try { process.kill(record.hostPid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      }
      // The viewing lock proves no live session in this process owns this record.
      // A reused live host PID is deliberately left alone, even if it looks stale.
      await this.clean(record);
    }
    // Persist intent before the first upload/start/forward, including startup crashes.
    writePrivateFileAtomicSync(this.path(this.record), JSON.stringify(this.record));
  }

  markShared(): void {
    this.record.shared = true;
    writePrivateFileAtomicSync(this.path(this.record), JSON.stringify(this.record));
  }

  clear(): void {
    try { unlinkSync(this.path(this.record)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  release(): void { if (!this.released) { this.lock.release(); this.released = true; } }
}
