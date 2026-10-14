import {
  RUN_STATUS_PHRASE_OUTPUT_RULE,
  RUN_STATUS_PHRASE_SYSTEM_PROMPT,
  RUN_STATUS_PHRASE_PROMPTS,
  isRunStatusPhraseStyle,
  selectRunStatusPhrasePrompt,
  type RunStatusPhraseLocale,
  type RunStatusPhraseStyle,
} from "./run-status-phrase-prompts";

export const RUN_STATUS_PHRASE_TIMEOUT_MS = 8_000;

export const RUN_STATUS_PHRASE_MAX_CHARS: Record<RunStatusPhraseLocale, number> = {
  "zh-CN": 40,
  en: 80,
};

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
  ["〈", "〉"],
];

/** Fragments of the output rule. A model that echoes the instruction is not a status line. */
const INSTRUCTION_ECHOES = [
  "只输出一行",
  "不超过40",
  "不要引号",
  "使用简体中文",
  "Output exactly one line",
  "at most 80",
  "No quotation marks",
  "Use English",
];

const INSTRUCTION_LINES = [
  ...Object.values(RUN_STATUS_PHRASE_PROMPTS).flatMap((prompts) => Object.values(prompts)),
  ...Object.values(RUN_STATUS_PHRASE_OUTPUT_RULE),
  ...Object.values(RUN_STATUS_PHRASE_SYSTEM_PROMPT),
].flatMap((prompt) => prompt.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);

/** Shorter lines are judged by exact match only, so brief real phrases survive. */
const ECHO_PREFIX_MIN_CHARS = 12;

function normalizeEcho(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const NORMALIZED_INSTRUCTION_LINES = INSTRUCTION_LINES.map(normalizeEcho).filter(Boolean);

/**
 * True when the model repeated the instruction: an echo fragment, an exact
 * instruction line (ignoring spacing and punctuation), or a long stretch
 * (>= 12 characters) copied from the start of one.
 */
export function isInstructionEcho(value: string): boolean {
  if (INSTRUCTION_ECHOES.some((fragment) => value.includes(fragment))) return true;
  const normalized = normalizeEcho(value);
  if (!normalized) return false;
  return NORMALIZED_INSTRUCTION_LINES.some((line) => {
    if (line === normalized) return true;
    const head = Math.min(line.length, normalized.length);
    if (head < ECHO_PREFIX_MIN_CHARS) return false;
    return line.slice(0, head) === normalized.slice(0, head);
  });
}

function stripWrappingQuotes(value: string): string {
  let current = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [start, end] of QUOTE_PAIRS) {
      if (current.startsWith(start) && current.endsWith(end) && current.length > start.length + end.length) {
        current = current.slice(start.length, -end.length).trim();
        changed = true;
      }
    }
  }
  return current;
}

function stripLineMarkup(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^(\*\*|__|\*|_|~~|`)(.+)\1$/, "$2")
    .trim();
}

/**
 * Keep one short display line. Anything empty, symbolic, or instructional
 * returns null so the caller can keep the fixed phrase.
 */
export function sanitizeRunStatusPhrase(raw: unknown, locale: RunStatusPhraseLocale): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.replace(/^\uFEFF/, "").trim();
  if (!value) return null;

  const fenced = value.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fenced) value = fenced[1].trim();

  value = (value.split(/\r?\n/, 1)[0] ?? "").trim();
  value = stripLineMarkup(value);
  value = stripWrappingQuotes(value);
  value = stripLineMarkup(value);
  value = stripWrappingQuotes(value);
  value = value.replace(/^(?:状态|status|line)\s*[:：-]\s*/i, "").trim();
  value = value.replace(/\s+/g, " ").trim();

  if (!value || !/[\p{L}\p{N}]/u.test(value)) return null;
  if (isInstructionEcho(value)) return null;

  const max = RUN_STATUS_PHRASE_MAX_CHARS[locale];
  const characters = Array.from(value);
  if (characters.length > max) value = characters.slice(0, max).join("").trim();
  if (!value || !/[\p{L}\p{N}]/u.test(value)) return null;
  if (isInstructionEcho(value)) return null;
  return value;
}

/** Fixed phrase unless generation is on and the model line is usable. */
export function resolveDisplayedRunStatusPhrase(input: {
  enabled: boolean;
  fixedPhrase: string;
  generated: unknown;
  locale: RunStatusPhraseLocale;
}): string {
  if (!input.enabled) return input.fixedPhrase;
  return sanitizeRunStatusPhrase(input.generated, input.locale) ?? input.fixedPhrase;
}

export interface RunStatusPhraseRequest {
  provider: string;
  modelId: string;
  cwd?: string;
  locale: RunStatusPhraseLocale;
  style: RunStatusPhraseStyle;
  /** Only for the custom style; the server puts it in the user message. */
  customPrompt?: string;
}

export function buildRunStatusPhraseRequest(input: {
  provider: string;
  modelId: string;
  cwd?: string;
  locale: RunStatusPhraseLocale;
  style: RunStatusPhraseStyle;
  customPrompt: string;
}): RunStatusPhraseRequest | null {
  const provider = input.provider.trim();
  const modelId = input.modelId.trim();
  if (!provider || !modelId) return null;
  const text = selectRunStatusPhrasePrompt(input.style, input.locale, input.customPrompt);
  if (!text) return null;
  const cwd = input.cwd?.trim();
  return {
    provider,
    modelId,
    ...(cwd ? { cwd } : {}),
    locale: input.locale,
    style: input.style,
    ...(input.style === "custom" ? { customPrompt: text } : {}),
  };
}

export function encodeRunStatusPhraseRequest(request: RunStatusPhraseRequest): string {
  return JSON.stringify(request);
}

export function parseRunStatusPhraseRequestKey(key: string): RunStatusPhraseRequest | null {
  try {
    const value = JSON.parse(key) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
    const locale = record.locale === "zh-CN" || record.locale === "en" ? record.locale : null;
    const style = isRunStatusPhraseStyle(record.style) ? record.style : null;
    if (!provider || !modelId || !locale || !style) return null;
    const customPrompt = typeof record.customPrompt === "string" ? record.customPrompt.trim() : "";
    if (style === "custom" && !customPrompt) return null;
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    return {
      provider,
      modelId,
      locale,
      style,
      ...(style === "custom" ? { customPrompt } : {}),
      ...(cwd ? { cwd } : {}),
    };
  } catch {
    return null;
  }
}

export interface RunStatusPhraseScheduler {
  /** One generation for this turn. Reuses a matching prefetch when one exists. */
  claimTurn(turnId: string, requestKey: string | null): Promise<string | null> | null;
  /** Fill the next-turn slot after a turn starts or ends. */
  prefetchNext(requestKey: string | null): void;
  /** Retarget a prefetch that is already waiting. Does not start one while idle. */
  noteIdleKey(requestKey: string | null): void;
  /** Abort an unclaimed prefetch, e.g. on unmount. */
  dispose(): void;
}

/**
 * At most one model call is claimed per turn. The call for the following turn
 * can start after this turn starts, or after it ends if that slot is empty.
 */
export function createRunStatusPhraseScheduler(
  generate: (requestKey: string, signal?: AbortSignal) => Promise<string | null>,
): RunStatusPhraseScheduler {
  let next: { key: string; promise: Promise<string | null>; controller: AbortController } | null = null;
  const claims = new Map<string, Promise<string | null>>();
  /** Claimed requests still in flight, so dispose() can cancel them too. */
  const inflight = new Set<AbortController>();

  function track(controller: AbortController, promise: Promise<string | null>): Promise<string | null> {
    inflight.add(controller);
    return promise.finally(() => inflight.delete(controller));
  }

  function run(key: string, controller?: AbortController): Promise<string | null> {
    return Promise.resolve()
      .then(() => (controller?.signal.aborted ? null : generate(key, controller?.signal)))
      .then((value) => (typeof value === "string" && value.trim() ? value : null))
      .catch(() => null);
  }

  /** Drop the unclaimed prefetch and cancel its request so it costs nothing more. */
  function dropNext(): void {
    next?.controller.abort();
    next = null;
  }

  function ensurePrefetch(key: string): void {
    if (next?.key === key) return;
    dropNext();
    const controller = new AbortController();
    next = { key, promise: run(key, controller), controller };
  }

  return {
    claimTurn(turnId, requestKey) {
      if (!requestKey) {
        dropNext();
        return null;
      }
      const existing = claims.get(turnId);
      if (existing) return existing;
      let promise: Promise<string | null>;
      if (next?.key === requestKey) {
        promise = track(next.controller, next.promise);
        next = null;
      } else {
        dropNext();
        const controller = new AbortController();
        promise = track(controller, run(requestKey, controller));
      }
      claims.set(turnId, promise);
      if (claims.size > 12) {
        const oldest = claims.keys().next().value;
        if (oldest && oldest !== turnId) claims.delete(oldest);
      }
      ensurePrefetch(requestKey);
      return promise;
    },
    prefetchNext(requestKey) {
      if (!requestKey) {
        dropNext();
        return;
      }
      ensurePrefetch(requestKey);
    },
    noteIdleKey(requestKey) {
      // Drop a stale prefetch without starting another. Typing a custom prompt
      // must not call the model once per keystroke.
      if (!next) return;
      if (!requestKey || next.key !== requestKey) dropNext();
    },
    dispose() {
      dropNext();
      for (const controller of inflight) controller.abort();
      inflight.clear();
    },
  };
}

export async function requestRunStatusPhrase(
  input: RunStatusPhraseRequest,
  fetchImpl: typeof fetch = fetch,
  cancel?: AbortSignal,
): Promise<string | null> {
  const timeout = cancel
    ? AbortSignal.any([AbortSignal.timeout(RUN_STATUS_PHRASE_TIMEOUT_MS), cancel])
    : AbortSignal.timeout(RUN_STATUS_PHRASE_TIMEOUT_MS);
  try {
    const response = await fetchImpl("/api/run-status-phrase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: timeout,
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const data = await response.json() as { phrase?: unknown };
    return sanitizeRunStatusPhrase(data.phrase, input.locale);
  } catch {
    return null;
  }
}
