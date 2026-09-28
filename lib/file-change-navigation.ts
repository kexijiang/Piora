import { parseUnifiedDiff } from "./diff-parse.ts";
import type { EditorLineChange } from "./file-editor-line-changes";

/** Inclusive, one-based positions in the editor or the flattened diff rows. */
export interface FileChangeRange { from: number; to: number }

export function getEditorChangeRanges(changes: readonly EditorLineChange[]): FileChangeRange[] {
  const ranges: FileChangeRange[] = [];
  for (const { line } of changes) {
    const last = ranges.at(-1);
    if (last && line <= last.to + 1) last.to = Math.max(last.to, line);
    else ranges.push({ from: line, to: line });
  }
  return ranges;
}

export function getDiffChangeRanges(patch: string): FileChangeRange[] {
  const ranges: FileChangeRange[] = [];
  let position = 0;
  for (const file of parseUnifiedDiff(patch).files) {
    for (const hunk of file.hunks) {
      let current: FileChangeRange | undefined;
      for (const line of hunk.lines) {
        position++;
        if (line.kind === "added" || line.kind === "removed") {
          if (current) current.to = position;
          else { current = { from: position, to: position }; ranges.push(current); }
        } else if (line.kind === "context") current = undefined;
      }
    }
  }
  return ranges;
}

export function getCurrentChangeIndex(ranges: readonly FileChangeRange[], position: number | null): number {
  return position === null ? -1 : ranges.findIndex(({ from, to }) => position >= from && position <= to);
}

export function getAdjacentChangeIndex(ranges: readonly FileChangeRange[], position: number | null, direction: -1 | 1): number {
  if (!ranges.length) return -1;
  if (position === null) return direction === 1 ? 0 : ranges.length - 1;
  if (direction === 1) {
    const index = ranges.findIndex(({ from }) => from > position);
    return index < 0 ? 0 : index;
  }
  for (let index = ranges.length - 1; index >= 0; index--) {
    if (ranges[index].to < position) return index;
  }
  return ranges.length - 1;
}
