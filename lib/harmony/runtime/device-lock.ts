import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { getRuntimeUserHomeDirectory as homedir } from "../../runtime-home";
import { join } from "node:path";
import { HarmonyError } from "../errors";

export const sharedDeviceLockDirectory = () => join(homedir(), ".piora-device-control", "locks");
interface Owner { pid: number; nonce: string; startedAt: string }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** All brands/profiles/processes use the same physical serial namespace. */
export function acquireDeviceLock(serial: string, directory = sharedDeviceLockDirectory()): { release(): void; owner: Owner } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new HarmonyError("DEVICE_BUSY", "Device lock directory cannot be a symlink");
  const path = join(directory, createHash("sha256").update(serial).digest("hex"));
  const gate = `${path}.gate`;
  // Serialize acquisition, dead-owner retirement and release. A crashed gate is
  // deliberately not stolen by timeout; explicit recovery must inspect its owner.
  const withGate = <T>(work: () => T): T => {
    try { mkdirSync(gate, { mode: 0o700 }); }
    catch { throw new HarmonyError("DEVICE_BUSY", "Device ownership is changing or needs explicit recovery"); }
    try { return work(); } finally { rmdirSync(gate); }
  };
  const owner: Owner = { pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
  return withGate(() => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600, flush: true });
      let released = false;
      return { owner, release() {
        if (released) return;
        withGate(() => {
        const current = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Owner;
        if (current.nonce !== owner.nonce) throw new HarmonyError("DEVICE_BUSY", "Device ownership changed; refusing foreign cleanup");
        released = true;
        rmSync(path, { recursive: true });
        });
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: Owner;
      try { previous = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Owner; }
      catch { throw new HarmonyError("DEVICE_BUSY", "Device ownership is being established or needs explicit recovery"); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1 || alive(previous.pid)) {
        throw new HarmonyError("DEVICE_BUSY", "Another application instance owns this physical device", { details: { ownerPid: previous.pid } });
      }
      // Reclaim only a positively dead owner, never merely an old heartbeat/PID file.
      if (lstatSync(path).isSymbolicLink()) throw new HarmonyError("DEVICE_BUSY", "Invalid device ownership path");
      const current = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Owner;
      if (current.nonce !== previous.nonce) continue;
      const retired = join(directory, `retired-${randomUUID()}`);
      try { renameSync(path, retired); } catch { continue; }
      if (existsSync(retired)) rmSync(retired, { recursive: true });
    }
  }
  throw new HarmonyError("DEVICE_BUSY", "Device ownership changed during acquisition");
  });
}
