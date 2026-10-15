import { randomBytes } from "node:crypto";
import { HarmonyError } from "../errors";

/**
 * Huawei's built-in screen recorder, driven over hdc as documented for DevEco Studio:
 * https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-screen-recording
 *
 * Start and stop are the SAME `aa start` toggle (start carries `--ps CustomizedFileName <name>`).
 * Piora therefore only sends a toggle when it can positively observe the recorder state, and
 * the recorded file stays in the user's gallery: only the `/data/local/tmp` staging copy is removed.
 */
export const SYSTEM_RECORDER_BUNDLE = "com.huawei.hmos.screenrecorder";
export const SYSTEM_RECORDER_ABILITY = "com.huawei.hmos.screenrecorder.ServiceExtAbility";
export const SYSTEM_RECORDING_STAGING_DIRECTORY = "/data/local/tmp";

/** `piora-<13 digit ms timestamp>-<8..32 alphanumerics>.mp4`; nothing else ever reaches a device shell. */
export const SYSTEM_RECORDING_NAME_PATTERN = /^piora-[0-9]{13}-[A-Za-z0-9]{8,32}\.mp4$/;

export type SystemRecorderState = "recording" | "idle" | "unknown";

export function generateSystemRecordingName(now: number = Date.now(), random: Buffer = randomBytes(6)): string {
  const name = `piora-${String(Math.trunc(now)).padStart(13, "0").slice(-13)}-${random.toString("hex")}.mp4`;
  return assertSystemRecordingName(name);
}

export function isSystemRecordingName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SYSTEM_RECORDING_NAME_PATTERN.test(value);
}

export function assertSystemRecordingName(value: unknown): string {
  if (!isSystemRecordingName(value)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Invalid system recording file name", { details: { dispatchState: "not-sent" } });
  }
  return value;
}

export function systemRecorderToggleArgs(name?: string): string[] {
  const args = ["aa", "start", "-b", SYSTEM_RECORDER_BUNDLE, "-a", SYSTEM_RECORDER_ABILITY];
  if (name !== undefined) args.push("--ps", "CustomizedFileName", assertSystemRecordingName(name));
  return args;
}

function clean(output: string): string { return output.replace(/\0/g, ""); }
const FAILURE = /(?:^|\r?\n)\s*(?:error\b|fail(?:ed|ure)?\b|permission denied)|\[(?:fail|error)\]|not\s+exist|not\s+found/i;

/** `bm dump -n <bundle>` names the bundle only when the system recorder is installed. */
export function systemRecorderInstalled(output: string): boolean {
  const text = clean(output);
  return text.includes(SYSTEM_RECORDER_BUNDLE) && !FAILURE.test(text);
}

/**
 * NEEDS REAL-DEVICE VALIDATION. Best-effort reading of `aa dump -a`.
 * - "recording": the dump mentions the recorder bundle (its ServiceExtAbility is alive).
 * - "idle": a recognisable ability dump that never mentions the recorder.
 * - "unknown": empty, failed or unrecognised output.
 * A lingering recorder process after a finished recording also reads as "recording", which
 * only makes Piora more conservative (it falls back to stream recording instead of toggling).
 */
export function parseSystemRecorderState(output: string): SystemRecorderState {
  const text = clean(output);
  if (!text.trim() || /\[(?:fail|error)\]|permission denied|error\s*:/i.test(text)) return "unknown";
  if (text.includes(SYSTEM_RECORDER_BUNDLE)) return "recording";
  return /User ID #\d+|MissionList|AbilityRecord|ExtensionRecord|AppRunningRecord|bundle name \[/i.test(text) ? "idle" : "unknown";
}

export function systemRecorderStartAccepted(output: string): boolean {
  const text = clean(output);
  return /start ability successfully/i.test(text) && !/\berror\s*:|\bfail(?:ed|ure)?\b|\[(?:fail|error)\]/i.test(text);
}

const MEDIA_URI = /^file:\/\/media\/[A-Za-z0-9_./-]+$/;
const DEVICE_PATH = /^\/[A-Za-z0-9_./-]+$/;

function safeEndingWith(value: string, pattern: RegExp, name: string): boolean {
  return pattern.test(value) && value.endsWith(`/${name}`) && !value.split("/").includes("..");
}

export type SystemRecordingLocation = { kind: "uri"; uri: string } | { kind: "path"; path: string };

/**
 * `mediatool query <name> -u`: when the reply carries a uri field the file must first be copied
 * with `mediatool recv <uri> /data/local/tmp`; otherwise the reply names a downloadable path.
 */
export function parseMediatoolQuery(output: string, name: string): SystemRecordingLocation | undefined {
  assertSystemRecordingName(name);
  const text = clean(output);
  if (FAILURE.test(text)) return undefined;
  const tokens = text.split(/[\s"',;]+/).map(token => token.trim()).filter(Boolean);
  const uri = tokens.find(token => safeEndingWith(token, MEDIA_URI, name));
  if (uri) return { kind: "uri", uri };
  if (/\buri\b/i.test(text)) return undefined;
  const path = tokens.find(token => safeEndingWith(token, DEVICE_PATH, name));
  return path ? { kind: "path", path } : undefined;
}

/** `mediatool recv` reports the staged path; only a copy inside /data/local/tmp is accepted. */
export function parseMediatoolRecv(output: string, name: string): string {
  assertSystemRecordingName(name);
  const expected = `${SYSTEM_RECORDING_STAGING_DIRECTORY}/${name}`;
  const text = clean(output);
  if (FAILURE.test(text)) throw new HarmonyError("COMMAND_FAILED", "The phone could not stage the system recording", { details: { reason: "system-recording-not-transferred", recordingStopped: true } });
  const staged = text.split(/[\s"',;]+/).find(token => token === expected);
  return staged ?? expected;
}

export function isStagedSystemRecording(path: string, name: string): boolean {
  return isSystemRecordingName(name) && path === `${SYSTEM_RECORDING_STAGING_DIRECTORY}/${name}`;
}
