export type AnswerLinkTarget = "builtin" | "system";
export const ANSWER_LINK_TARGET_STORAGE_KEY = "piora-answer-link-target:v1";

export function parseAnswerLinkTarget(value: string | null): AnswerLinkTarget {
  return value === "system" ? "system" : "builtin";
}

/** Only ordinary web URLs enter the browser panel; files retain their own handler. */
export function normalizeAnswerLink(href: string | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href) || /[\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const url = new URL(href);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function answerLinkTargetForClick(target: AnswerLinkTarget, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): AnswerLinkTarget {
  return event.ctrlKey || event.metaKey || event.shiftKey
    ? target === "builtin" ? "system" : "builtin"
    : target;
}

export interface BrowserNavigationRequest {
  id: string;
  url: string;
  newTab?: boolean;
}
