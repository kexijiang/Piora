// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
export type LogProcess = { pid: number; name: string };
export function logProcessMatches(name: string, target: string) {
  return name === target || name.startsWith(`${target}:`);
}
export function logApplicationPids(processes: LogProcess[], bundle: string, process?: string) {
  const names = [bundle, process].filter((value): value is string => Boolean(value));
  return new Set(processes.filter(item => names.some(name => logProcessMatches(item.name, name))).map(item => item.pid));
}
/** PID map plus the explicit process column in HiLog; never match arbitrary message text. */
export function logBelongsToApplication(entry: { pid?: number; process?: string; domain?: string; tag?: string }, bundle: string, pids: Set<number>, process?: string) {
  if (!bundle) return true;
  if (entry.pid !== undefined && pids.has(entry.pid)) return true;
  const parts = `${entry.domain ?? ""}/${entry.tag ?? ""}`.split("/").filter(Boolean);
  const recordedProcess = entry.process ?? (/^[A-Za-z]?[0-9a-f]{4,8}$/i.test(parts[0] ?? "") ? parts[1] : undefined);
  return Boolean(recordedProcess && [bundle, process].some(name => name && logProcessMatches(recordedProcess, name)));
}
