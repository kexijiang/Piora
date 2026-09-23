import { parseUnifiedDiff } from "./diff-parse.ts";

export type EditorLineChangeKind = "added" | "modified" | "deleted";
export interface EditorLineChange { line: number; kind: EditorLineChangeKind }

interface AddedLine { line: number; text: string }

function lineSimilarity(left: string, right: string): number {
  if (!left || !right) return left === right ? 1 : 0;
  let prefix = 0;
  while (prefix < Math.min(left.length, right.length, 128) && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(left.length, right.length) - prefix && suffix < 128 && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return (prefix + suffix) / Math.max(left.length, right.length);
}

/** Pair replacement lines by content so adjacent insertions retain their own color. */
function classifyAddedLines(removed: string[], added: AddedLine[]): EditorLineChange[] {
  if (!removed.length) return added.map(({ line }) => ({ line, kind: "added" }));
  if (!added.length) return [];

  const oldCount = removed.length;
  const newCount = added.length;
  const paired = new Set<number>();
  if (oldCount * newCount <= 160_000) {
    const oldText = removed.map((line) => line.trim());
    const newText = added.map(({ text }) => text.trim());
    const width = newCount + 1;
    const scores = new Float64Array((oldCount + 1) * width);
    const pairWeight = oldCount + newCount + 1;
    for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
        const cell = oldIndex * width + newIndex;
        scores[cell] = Math.max(
          scores[cell + width],
          scores[cell + 1],
          pairWeight + lineSimilarity(oldText[oldIndex], newText[newIndex]) + scores[cell + width + 1],
        );
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldCount && newIndex < newCount) {
      const cell = oldIndex * width + newIndex;
      const matched = pairWeight + lineSimilarity(oldText[oldIndex], newText[newIndex]) + scores[cell + width + 1];
      if (matched >= scores[cell] - 1e-8) {
        paired.add(newIndex);
        oldIndex += 1;
        newIndex += 1;
      } else if (scores[cell + 1] >= scores[cell + width]) {
        newIndex += 1;
      } else {
        oldIndex += 1;
      }
    }
  } else {
    for (let index = 0; index < Math.min(oldCount, newCount); index += 1) paired.add(index);
  }
  return added.map(({ line }, index) => ({ line, kind: paired.has(index) ? "modified" : "added" }));
}

export function normalizeFileLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function getFileLineSeparator(value: string): "\r\n" | "\r" | "\n" {
  const withoutCrlf = value.replaceAll("\r\n", "");
  if (value.includes("\r\n") && !withoutCrlf.includes("\n") && !withoutCrlf.includes("\r")) return "\r\n";
  if (value.includes("\r") && !value.includes("\n")) return "\r";
  return "\n";
}

export function preserveFileLineEndings(draft: string, saved: string): string {
  const separator = getFileLineSeparator(saved);
  return separator === "\n" ? draft : normalizeFileLineEndings(draft).replaceAll("\n", separator);
}

/** Marks the displayed side of a Git patch. Cache this while a draft is edited. */
export function getGitFileLineChanges(patch: string | null, savedLineCount: number): EditorLineChange[] {
  const git = new Map<number, EditorLineChangeKind>();

  if (patch) {
    for (const file of parseUnifiedDiff(patch).files) {
      for (const hunk of file.hunks) {
        const removed: string[] = [];
        const added: AddedLine[] = [];
        let nextLine = hunk.newStart;
        const flush = () => {
          if (added.length) {
            for (const { line, kind } of classifyAddedLines(removed, added)) git.set(line, kind);
          } else if (removed.length) {
            git.set(Math.max(1, Math.min(savedLineCount, nextLine)), "deleted");
          }
          removed.length = 0;
          added.length = 0;
        };
        for (const line of hunk.lines) {
          if (line.kind === "removed") removed.push(line.text);
          else if (line.kind === "added" && line.newLine !== null) {
            added.push({ line: line.newLine, text: line.text });
            nextLine = line.newLine + 1;
          } else if (line.kind === "context") {
            flush();
            nextLine = (line.newLine ?? nextLine) + 1;
          }
        }
        flush();
      }
    }
  }

  return [...git].map(([line, kind]) => ({ line, kind })).sort((a, b) => a.line - b.line);
}

/** Remaps saved Git markers and adds live markers for the current draft. */
export function getDraftFileLineChanges(gitChanges: EditorLineChange[], saved: string, draft: string): EditorLineChange[] {
  if (normalizeFileLineEndings(saved) === normalizeFileLineEndings(draft)) return gitChanges;
  const savedLines = normalizeFileLineEndings(saved).split("\n");
  const draftLines = normalizeFileLineEndings(draft).split("\n");

  let prefix = 0;
  while (prefix < Math.min(savedLines.length, draftLines.length) && savedLines[prefix] === draftLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < savedLines.length - prefix && suffix < draftLines.length - prefix &&
    savedLines[savedLines.length - 1 - suffix] === draftLines[draftLines.length - 1 - suffix]) suffix += 1;

  const remapped = new Map<number, EditorLineChangeKind>();
  const delta = draftLines.length - savedLines.length;
  for (const { line, kind } of gitChanges) {
    const index = line - 1;
    if (index < prefix) remapped.set(line, kind);
    else if (index >= savedLines.length - suffix) remapped.set(Math.max(1, line + delta), kind);
  }

  const oldChangedCount = savedLines.length - prefix - suffix;
  const newChangedCount = draftLines.length - prefix - suffix;
  // Keep markers precise when several separated edits exist in one draft.
  // Bound the matrix so large files still respond immediately while typing.
  if (oldChangedCount * newChangedCount <= 160_000) {
    const width = newChangedCount + 1;
    const lcs = new Uint32Array((oldChangedCount + 1) * width);
    for (let oldIndex = oldChangedCount - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newChangedCount - 1; newIndex >= 0; newIndex -= 1) {
        const cell = oldIndex * width + newIndex;
        lcs[cell] = savedLines[prefix + oldIndex] === draftLines[prefix + newIndex]
          ? lcs[cell + width + 1] + 1
          : Math.max(lcs[cell + width], lcs[cell + 1]);
      }
    }
    const gitByLine = new Map(gitChanges.map(({ line, kind }) => [line, kind]));
    let oldIndex = 0;
    let newIndex = 0;
    const removed: string[] = [];
    const added: AddedLine[] = [];
    const flush = () => {
      if (added.length) {
        for (const { line, kind } of classifyAddedLines(removed, added)) remapped.set(line, kind);
      } else if (removed.length) {
        remapped.set(Math.max(1, Math.min(draftLines.length, prefix + newIndex + 1)), "deleted");
      }
      removed.length = 0;
      added.length = 0;
    };
    while (oldIndex < oldChangedCount || newIndex < newChangedCount) {
      if (oldIndex < oldChangedCount && newIndex < newChangedCount &&
        savedLines[prefix + oldIndex] === draftLines[prefix + newIndex]) {
        flush();
        const kind = gitByLine.get(prefix + oldIndex + 1);
        if (kind) remapped.set(prefix + newIndex + 1, kind);
        oldIndex += 1;
        newIndex += 1;
      } else if (newIndex < newChangedCount && (oldIndex === oldChangedCount ||
        lcs[oldIndex * width + newIndex + 1] >= lcs[(oldIndex + 1) * width + newIndex])) {
        added.push({ line: prefix + newIndex + 1, text: draftLines[prefix + newIndex] });
        newIndex += 1;
      } else {
        removed.push(savedLines[prefix + oldIndex]);
        oldIndex += 1;
      }
    }
    flush();
    return [...remapped].map(([line, kind]) => ({ line, kind })).sort((a, b) => a.line - b.line);
  }

  if (newChangedCount > 0) {
    const localKind: EditorLineChangeKind = oldChangedCount > 0 ? "modified" : "added";
    for (let index = prefix; index < prefix + newChangedCount; index += 1) {
      const line = index + 1;
      remapped.set(line, remapped.get(line) === "added" ? "added" : localKind);
    }
  } else if (oldChangedCount > 0) {
    remapped.set(Math.max(1, Math.min(draftLines.length, prefix + 1)), "deleted");
  }

  return [...remapped].map(([line, kind]) => ({ line, kind })).sort((a, b) => a.line - b.line);
}

export function getFileEditorLineChanges(patch: string | null, saved: string, draft: string): EditorLineChange[] {
  return getDraftFileLineChanges(getGitFileLineChanges(patch, normalizeFileLineEndings(saved).split("\n").length), saved, draft);
}
