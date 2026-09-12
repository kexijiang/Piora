"use client";
import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { chooseReply, replySpanKey, type ReplyDraft, type ReplySpan } from "@/lib/reply-draft";
import type { ReplyGroup, ReplyOption, ReplyResult } from "@/lib/reply-suggestions";
import styles from "./ReplySuggestionBar.module.css";

interface Props { sourceKey: string; result?: ReplyResult; error?: string; retry?: () => void; draft: ReplyDraft; onChange: (draft: ReplyDraft, caret?: number) => void; preview?: boolean }
export function replyErrorKey(error: string) { return `reply.error.${["model_unavailable", "invalid_settings", "timeout", "invalid_output", "network_error", "busy"].includes(error) ? error : "provider_error"}`; }
export function ReplySuggestionBar(props: Props) {
  // Remount presentation state for every source/config while keeping the parent-owned draft intact.
  return <ReplyChoices key={props.sourceKey} {...props} />;
}
function ReplyChoices({ sourceKey, result, error, draft, onChange }: Props) {
  const { t } = useI18n();
  const [conflict, setConflict] = useState<{ span: ReplySpan; group: ReplyGroup; option: ReplyOption } | null>(null);
  const pointer = useRef(false);
  const currentConflict = conflict && draft.spans.find((s) => s.key === conflict.span.key);
  const choose = (group: ReplyGroup, option: ReplyOption, mouse = false, force = false) => {
    const next = chooseReply(draft, sourceKey, group, option, force);
    if (next.conflict) { setConflict({ span: next.conflict, group, option }); return; }
    setConflict(null); onChange(next.draft, mouse ? next.caret : undefined);
  };
  // Keep the composer quiet: one flat row of bubbles, with no persistent controls.
  if (error || !result?.groups.length) return null;
  const choices = result.groups.flatMap((group) => group.options.map((option) => ({ group, option })));
  return <section className={styles.bar} aria-label={t("reply.title")}>
    <div className={styles.options}>
      {choices.map(({ group, option }, index) => {
        const checked = draft.spans.some((s) => s.key === replySpanKey(sourceKey, option));
        return <button type="button" key={option.id} className={styles.chip} aria-pressed={checked}
          title={option.insertText}
          onPointerDown={(event) => { pointer.current = event.pointerType === "mouse"; }}
          onClick={(event) => { choose(group, option, event.detail > 0 && pointer.current); pointer.current = false; }}
          onKeyDown={(event) => {
            pointer.current = false;
            if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
            (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
          }}>
          {option.label}
        </button>;
      })}
    </div>
    {conflict && currentConflict && <div className={styles.conflict} role="alert">
      <strong>{t("reply.edited")}</strong><p>{draft.value.slice(currentConflict.start, currentConflict.end)}</p>
      {currentConflict.optionId !== conflict.option.id && <><span>{t("reply.replacement")}</span><p>{conflict.option.insertText}</p></>}
      <div className={styles.actions}><button type="button" className={styles.action} onClick={() => setConflict(null)}>{t("reply.keep")}</button><button type="button" className={styles.action} onClick={() => choose(conflict.group, conflict.option, false, true)}>{t(currentConflict.optionId === conflict.option.id ? "reply.remove" : "reply.replace")}</button></div>
    </div>}
  </section>;
}
