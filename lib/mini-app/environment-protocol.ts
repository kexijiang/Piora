import { boundedJson, exactKeys, jsonRecord } from "./json";
import { MiniAppError } from "./limits";

export const MINI_APP_RENDERER_PROTOCOL = "mini-app-renderer-2";
// Allow for background-tab timer throttling. Closing, context loss and source
// replacement still revoke immediately; this only bounds missed heartbeats.
export const MINI_APP_ENVIRONMENT_TTL = 180_000;
export interface MiniAppGraphicsReport { protocol: typeof MINI_APP_RENDERER_PROTOCOL; webgl: boolean }
export interface MiniAppEnvironmentReport extends MiniAppGraphicsReport { instance: string; epoch: number; sequence: number; rendererDigest: string }
export function validateMiniAppGraphicsReport(value: unknown): MiniAppGraphicsReport {
  const report = jsonRecord(value, "graphics"); exactKeys(report, ["protocol", "webgl"], "graphics");
  if (report.protocol !== MINI_APP_RENDERER_PROTOCOL || typeof report.webgl !== "boolean") throw new MiniAppError("ENVIRONMENT", "Unsupported renderer environment report");
  return { protocol: MINI_APP_RENDERER_PROTOCOL, webgl: report.webgl };
}
export function validateMiniAppEnvironmentReport(value: unknown): MiniAppEnvironmentReport {
  boundedJson(value, 2000, "environment");
  const report = jsonRecord(value, "environment"); exactKeys(report, ["protocol", "webgl", "instance", "epoch", "sequence", "rendererDigest"], "environment");
  const graphics = validateMiniAppGraphicsReport({ protocol: report.protocol, webgl: report.webgl });
  if (typeof report.instance !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(report.instance)
    || !Number.isSafeInteger(report.epoch) || (report.epoch as number) < 1
    || !Number.isSafeInteger(report.sequence) || (report.sequence as number) < 1
    || typeof report.rendererDigest !== "string" || !/^[0-9a-f]{64}$/.test(report.rendererDigest)) throw new MiniAppError("ENVIRONMENT", "Invalid renderer environment identity");
  return { ...graphics, instance: report.instance, epoch: report.epoch as number, sequence: report.sequence as number, rendererDigest: report.rendererDigest };
}
