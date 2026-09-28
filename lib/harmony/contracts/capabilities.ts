export interface HarmonyActionCapability {
  action: string;
  status: "supported" | "unsupported" | "unknown" | "needs-calibration" | "unavailable";
  provider: string;
  evidence: "declared" | "probed" | "verified";
  reason: string;
  probedAt?: string;
  deviceEpoch?: number;
  constraints?: Record<string, string | number | boolean>;
}
export interface HarmonyDoctorReport {
  serial: string;
  deviceEpoch: number;
  checkedAt: string;
  versions: { os?: string; api?: string; uitest?: string; deveco?: string; devecoCli?: string; hdc?: string; hypium?: string };
  capabilities: HarmonyActionCapability[];
  checks: Array<{ name: string; status: "passed" | "failed" | "unknown"; reason?: string }>;
  nextActions: string[];
}
