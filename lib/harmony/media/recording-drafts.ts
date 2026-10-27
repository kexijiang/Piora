import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HarmonyRecordingState } from "../types";
export class RecordingDrafts {
  constructor(private root: string) {}
  path(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid recording ID"); return join(this.root, `${id}.mp4`); }
  save(state: HarmonyRecordingState, finalized = false) {
    mkdirSync(this.root, { recursive: true });
    const file = `${this.path(state.recordingId)}.json`;
    let previous = false;
    try { previous = JSON.parse(readFileSync(file, "utf8")).finalized === true; } catch { /* New recording. */ }
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, state, finalized: finalized || previous }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  list(): Array<{ state: HarmonyRecordingState; finalized: boolean }> {
    let files: string[]; try { files = readdirSync(this.root); } catch { return []; }
    return files.filter(file => /^[a-f0-9]{24}\.mp4\.json$/.test(file)).slice(0, 200).flatMap(file => {
      try {
        const text = readFileSync(join(this.root, file), "utf8"); if (text.length > 16000) return [];
        const data = JSON.parse(text), state = data.state;
        if (data.version !== 1 || !state || `${state.recordingId}.mp4.json` !== file || typeof state.serial !== "string" || typeof state.ownerId !== "string" || typeof state.startedAt !== "string") return [];
        const system = state.method === "system-recorder" && typeof state.systemFileName === "string";
        if (!system && !existsSync(this.path(state.recordingId))) return [];
        return [{ state: { ...state, ...(system ? { systemRecorderStateUnknown: true } : {}), phase: "recoverable", recoveryAvailable: true } as HarmonyRecordingState, finalized: data.finalized === true || system }];
      } catch { return []; }
    });
  }
  clear(id: string) { for (const file of [this.path(id), `${this.path(id)}.json`]) try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
