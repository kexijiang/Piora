"use client";

import { useMemo } from "react";
import { diffLines } from "diff";

/** Bounded local preview only. Saving still verifies the device's original hash. */
export function TextDiff({ original, edited, chinese }: { original: string; edited: string; chinese: boolean }) {
  const result = useMemo(() => {
    if (original.length + edited.length > 200_000 || (original.match(/\n/g)?.length ?? 0) + (edited.match(/\n/g)?.length ?? 0) > 4_000) return "large" as const;
    return diffLines(original, edited, { timeout: 500, maxEditLength: 1_000 });
  }, [original, edited]);
  const preview = useMemo(() => {
    if (!Array.isArray(result)) return { parts: [], truncated: false };
    let remaining = 40_000;
    let truncated = false;
    const parts = result.flatMap((change, index) => {
      if (remaining <= 0) { truncated = true; return []; }
      const value = !change.added && !change.removed && change.value.length > 600
        ? `${change.value.slice(0, 200)}\n… ${chinese ? "省略未变化内容" : "unchanged content omitted"} …\n${change.value.slice(-200)}`
        : change.value;
      const visible = value.slice(0, remaining);
      remaining -= visible.length;
      if (visible.length < value.length) truncated = true;
      return [{ key: index, value: visible, added: change.added, removed: change.removed }];
    });
    return { parts, truncated };
  }, [result, chinese]);
  if (result === "large" || !result) return <p>{chinese ? "差异预览超出大小或计算时间限制；仍可编辑并核对哈希保存。" : "Diff preview exceeded its size or time limit. Editing and hash-checked save remain available."}</p>;
  if (result.every(change => !change.added && !change.removed)) return <p>{chinese ? "内容没有变化。" : "No content changes."}</p>;
  return <div aria-label={chinese ? "文本差异预览" : "Text diff preview"} style={{ maxHeight: 320, overflow: "auto" }}><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {preview.parts.map(change => <span key={change.key} style={{ color: change.added ? "#177245" : change.removed ? "#a42b32" : "inherit" }}>
      {change.added ? "+ " : change.removed ? "- " : "  "}{change.value}
    </span>)}
    {preview.truncated ? <span>…</span> : null}
  </pre></div>;
}
