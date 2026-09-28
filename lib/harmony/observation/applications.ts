import { HarmonyError } from "../errors";
export interface HarmonyApplication {
  bundleName: string;
  label?: string;
  abilities?: string[];
  versionName?: string;
  versionCode?: number;
  installTime?: number;
  updateTime?: number;
  requestedPermissions?: string[];
  source: "bm-label" | "bm-bundle";
}
const identifier = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
export function parseApplicationLabels(output: string): HarmonyApplication[] {
  try {
    const start = output.indexOf("["), end = output.lastIndexOf("]");
    const rows = JSON.parse(output.slice(start, end + 1)) as unknown;
    if (!Array.isArray(rows) || rows.length > 5000) throw new Error("Invalid list");
    return rows.flatMap(row => row && typeof row.bundleName === "string" && identifier.test(row.bundleName) && typeof row.label === "string"
      ? [{ bundleName: row.bundleName, label: row.label.slice(0, 512), source: "bm-label" as const }] : []);
  } catch { throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device cannot provide application labels; search bundle identifiers instead"); }
}
export function parseBundleList(output: string): HarmonyApplication[] {
  const names = output.split(/\r?\n/).map(line => line.trim()).filter(line => identifier.test(line) && line.includes("."));
  if (!names.length || names.length > 5000) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The installed application list is unavailable");
  return [...new Set(names)].map(bundleName => ({ bundleName, source: "bm-bundle" }));
}
export function parseApplicationAbilities(output: string, bundleName: string): string[] {
  try {
    const data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (data.name !== bundleName && data.applicationInfo?.bundleName !== bundleName && data.bundleName !== bundleName) throw new Error("Bundle identity differs");
    const abilities = [...(data.abilityInfos ?? []), ...(data.hapModuleInfos ?? []).flatMap((module: { abilityInfos?: unknown[] }) => module.abilityInfos ?? [])];
    return [...new Set<string>(abilities.filter(item => item.exported === true && item.enabled !== false && typeof item.name === "string" && identifier.test(item.name)).map(item => item.name))].sort();
  } catch { throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The application ability list could not be verified"); }
}

/** Extract only stable, bounded bundle facts; device output is never trusted as a command. */
export function parseApplicationDetails(output: string, bundleName: string): HarmonyApplication {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (data.name !== bundleName && data.bundleName !== bundleName
      && (data.applicationInfo as { bundleName?: unknown } | undefined)?.bundleName !== bundleName) throw new Error("Bundle identity differs");
  } catch { throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The application details could not be verified"); }
  const text = (value: unknown) => typeof value === "string" && value.length <= 512 ? value : undefined;
  const numeric = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const permissions = Array.isArray(data.reqPermissions) ? data.reqPermissions : [];
  return {
    bundleName, source: "bm-bundle", abilities: parseApplicationAbilities(output, bundleName),
    versionName: text(data.versionName), versionCode: numeric(data.versionCode),
    installTime: numeric(data.installTime), updateTime: numeric(data.updateTime),
    requestedPermissions: [...new Set(permissions.flatMap(item => {
      const name = typeof item === "string" ? item : item && typeof item === "object" ? (item as { name?: unknown }).name : undefined;
      return typeof name === "string" && /^ohos\.permission\.[A-Z0-9_]{1,120}$/.test(name) ? [name] : [];
    }))].slice(0, 200),
  };
}
