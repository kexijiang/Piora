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
  isSystemApp?: boolean;
  removable?: boolean;
  dataClearable?: boolean;
  enabled?: boolean;
  debug?: boolean;
  provisionType?: "debug" | "release";
  installSource?: string;
  process?: string;
  source: "bm-label" | "bm-bundle";
}
const identifier = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
function applicationFacts(data: Record<string, unknown>, bundleName: string): Partial<HarmonyApplication> {
  const candidate = data.applicationInfo;
  const info = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && ((candidate as Record<string, unknown>).bundleName === bundleName || (candidate as Record<string, unknown>).name === bundleName)
    ? candidate as Record<string, unknown> : data;
  const bool = (...values: unknown[]) => {
    const known = values.filter((value): value is boolean => typeof value === "boolean");
    return known.length && known.every(value => value === known[0]) ? known[0] : undefined;
  };
  const system = bool(info.isSystemApp, info.systemApp);
  const removable = bool(info.removable), enabled = bool(info.enabled), debug = bool(info.debug);
  const clearable = bool(info.userDataClearable, typeof info.dataUnclearable === "boolean" ? !info.dataUnclearable : undefined);
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
  const installSource = text(info.installSource), process = text(info.process);
  return {
    ...(system !== undefined ? { isSystemApp: system } : {}), ...(removable !== undefined ? { removable } : {}),
    ...(clearable !== undefined ? { dataClearable: clearable } : {}), ...(enabled !== undefined ? { enabled } : {}),
    ...(debug !== undefined ? { debug } : {}), ...(info.appProvisionType === "debug" || info.appProvisionType === "release" ? { provisionType: info.appProvisionType } : {}),
    ...(installSource ? { installSource } : {}), ...(process && /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(process) ? { process } : {}),
  };
}
export function parseApplicationLabels(output: string): HarmonyApplication[] {
  try {
    const start = output.indexOf("["), end = output.lastIndexOf("]");
    const rows = JSON.parse(output.slice(start, end + 1)) as unknown;
    if (!Array.isArray(rows) || rows.length > 5000) throw new Error("Invalid list");
    return rows.flatMap(row => row && typeof row.bundleName === "string" && identifier.test(row.bundleName)
      ? [{ bundleName: row.bundleName, ...(typeof row.label === "string" ? { label: row.label.slice(0, 512) } : {}), ...applicationFacts(row, row.bundleName), source: "bm-label" as const }] : []);
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
    return [...new Set<string>(abilities.filter(item => {
      // bm dumps use visible, while module metadata can use exported. Require
      // an explicit true and reject contradictory or malformed declarations.
      const visibility = [item.exported, item.visible].filter(value => value !== undefined);
      return visibility.length > 0 && visibility.every(value => value === true)
        && item.enabled !== false && typeof item.name === "string" && identifier.test(item.name);
    }).map(item => item.name))].sort();
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
    ...applicationFacts(data, bundleName),
    requestedPermissions: [...new Set(permissions.flatMap(item => {
      const name = typeof item === "string" ? item : item && typeof item === "object" ? (item as { name?: unknown }).name : undefined;
      return typeof name === "string" && /^ohos\.permission\.[A-Z0-9_]{1,120}$/.test(name) ? [name] : [];
    }))].slice(0, 200),
  };
}
