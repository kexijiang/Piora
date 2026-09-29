import type { HarmonyDeviceFile } from "@/lib/harmony/device-files";

export type FileSortKey = "name" | "kind" | "size" | "modifiedAt";

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function visibleDeviceFiles(files: HarmonyDeviceFile[], showHidden: boolean, sortKey: FileSortKey, descending: boolean): HarmonyDeviceFile[] {
  const direction = descending ? -1 : 1;
  const compareOptional = (left: number | undefined, right: number | undefined) =>
    left === undefined ? (right === undefined ? 0 : 1) : right === undefined ? -1 : direction * (left - right);
  return files.filter(file => showHidden || !file.name.startsWith(".")).sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (right.kind === "directory" && left.kind !== "directory") return 1;
    let result = 0;
    if (sortKey === "name") result = direction * names.compare(left.name, right.name);
    else if (sortKey === "kind") result = direction * names.compare(left.kind, right.kind);
    else if (sortKey === "size") result = compareOptional(left.size, right.size);
    else result = compareOptional(left.modifiedAt, right.modifiedAt);
    return result || names.compare(left.name, right.name) || left.path.localeCompare(right.path);
  });
}
