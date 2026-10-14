/**
 * Conservative link detection for user messages, which are rendered as plain
 * text. Only URLs and unambiguous file paths are detected; everything else
 * (plain words, version numbers, "a/b" prose, slash commands) stays literal.
 */

export type UserMessageSegment =
  | { type: "text"; text: string }
  | { type: "url"; text: string; href: string }
  | { type: "path"; text: string; path: string; kind: UserMessagePathKind };

export type UserMessagePathKind = "absolute" | "windows" | "home" | "dot-relative" | "relative";

// Path segment characters: ASCII only, no spaces or quotes, so adjacent CJK
// prose and punctuation are never swallowed into a path.
const SEG = String.raw`[A-Za-z0-9_.+\-%~=,]+`;
const LINE = String.raw`(?::\d+(?::\d+)?)?`;
const URL_SOURCE = String.raw`https?:\/\/[^\s<>"'\`，。；！？、（）【】「」《》]+`;

const LINK_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_./\\~:%+\-])(?:` +
  `(?<url>${URL_SOURCE})` +
  `|(?<windows>[A-Za-z]:[\\\\/](?:${SEG}[\\\\/])*${SEG}${LINE})` +
  `|(?<home>~\\/(?:${SEG}\\/)*${SEG}${LINE})` +
  `|(?<dot>\\.\\.?\\/(?:${SEG}\\/)*${SEG}${LINE})` +
  `|(?<absolute>\\/(?:${SEG}\\/)*${SEG}${LINE})` +
  `|(?<relative>${SEG}(?:\\/${SEG})+${LINE})` +
  ")",
  "g",
);

const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

function trimTrailing(value: string, isUrl: boolean): string {
  let result = value;
  for (;;) {
    const before = result;
    result = result.replace(TRAILING_PUNCTUATION, "");
    if (isUrl) {
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
        if (result.endsWith(close) && result.split(open).length < result.split(close).length) {
          result = result.slice(0, -1);
        }
      }
    }
    if (result === before) return result;
  }
}

function stripLine(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function lastSegment(value: string): string {
  const parts = stripLine(value).split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function isAcceptedPath(kind: UserMessagePathKind, value: string): boolean {
  const withoutLine = stripLine(value);
  const segments = withoutLine.split(/[\\/]/).filter(Boolean);
  const hasExtension = FILE_EXTENSION.test(lastSegment(value));
  if (segments.some((segment) => /^\.{3,}$/.test(segment))) return false;
  switch (kind) {
    case "windows":
    case "home":
    case "dot-relative":
      return segments.length >= (kind === "windows" ? 2 : 1);
    case "absolute":
      // "/compact" is a slash command, not a path; require depth or an extension.
      return segments.length >= 2 || hasExtension;
    case "relative":
      // "a/b", "TCP/IP", "1.2/3.4" are prose; require a real file extension and
      // a first segment that is not only digits/dots.
      return hasExtension && !/^[\d.]+$/.test(segments[0] ?? "");
  }
}

export function detectUserMessageLinks(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.type === "text") previous.text += value;
    else segments.push({ type: "text", text: value });
  };

  for (const match of text.matchAll(LINK_PATTERN)) {
    const groups = match.groups ?? {};
    const start = match.index ?? 0;
    let segment: UserMessageSegment | null = null;
    let raw = "";
    if (groups.url) {
      raw = trimTrailing(groups.url, true);
      if (/^https?:\/\/[^/?#\s]+/.test(raw)) segment = { type: "url", text: raw, href: raw };
    } else {
      const kind: UserMessagePathKind = groups.windows ? "windows"
        : groups.home ? "home"
          : groups.dot ? "dot-relative"
            : groups.absolute ? "absolute"
              : "relative";
      raw = trimTrailing(match[0], false);
      if (isAcceptedPath(kind, raw)) segment = { type: "path", text: raw, path: raw, kind };
    }
    if (!segment) continue;
    pushText(text.slice(cursor, start));
    segments.push(segment);
    cursor = start + raw.length;
  }
  pushText(text.slice(cursor));
  return segments;
}
