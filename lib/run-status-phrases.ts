/**
 * One status line per agent turn, in Piora's own voice:
 * π unrolling, ora / aurora light, the carry-pod (随身舱), the companion pet,
 * and the pastel skins and wallpapers. These are fixed copy, never model output.
 */

export interface RunStatusPhrase {
  id: string;
  zh: string;
  en: string;
}

export const RUN_STATUS_PHRASES: readonly RunStatusPhrase[] = [
  { id: "piUnrolling", zh: "π 的小数还在往下铺", en: "Pi's digits are still unrolling" },
  { id: "oraKindling", zh: "极光顺着 ora 慢慢亮起来", en: "Aurora is kindling along the ora" },
  { id: "carryPodLamp", zh: "随身舱的灯还亮着", en: "The carry-pod lamp is still lit" },
  { id: "petThread", zh: "桌宠把线头衔了过来", en: "The companion pet brought the loose thread" },
  { id: "pastelWarp", zh: "粉彩正在代码的经线上走", en: "Pastel is walking the warp of the code" },
  { id: "starlightMist", zh: "星光玻璃后面起了一层雾", en: "Mist is gathering behind the starlight glass" },
  { id: "circleWriting", zh: "圆周还在一笔一笔往下写", en: "The circle is still being written, digit by digit" },
  { id: "stitchTurn", zh: "这一轮正缝进随身舱", en: "This turn is being stitched into the carry-pod" },
  { id: "sageInk", zh: "鼠尾草纸上的墨还没干", en: "The ink on sage paper is still wet" },
  { id: "cloudBearBrackets", zh: "云朵小熊把括号扶正了", en: "Cloud Bear is straightening the brackets" },
  { id: "sakuraLine", zh: "樱雾正飘过这一行", en: "Sakura mist is drifting across this line" },
  { id: "auroraDarn", zh: "有人在极光玻璃后织补", en: "Someone is darning behind the aurora glass" },
  { id: "focusClock", zh: "专注时钟在随身舱里走着", en: "The focus clock keeps time in the carry-pod" },
  { id: "nextDigit", zh: "π 的下一位还没落定", en: "The next digit of π has not settled" },
  { id: "petAtLight", zh: "桌宠蹲在光边看着", en: "The pet is crouched at the edge of the light" },
  { id: "wallpaperStars", zh: "壁纸上的星海还在转", en: "The wallpaper starfield is still turning" },
  { id: "candyLights", zh: "糖果屋的灯串还没数完", en: "The candy-house lights are still uncounted" },
  { id: "doodleLines", zh: "手绘壁纸上的线还在长", en: "Lines on the doodle wallpaper are still growing" },
];

export type RunStatusPhraseId = (typeof RUN_STATUS_PHRASES)[number]["id"];

export function runStatusPhraseKey(id: string): string {
  return `runStatus.phrase.${id}`;
}

function phraseMessages(language: "zh" | "en"): Record<string, string> {
  return Object.fromEntries(RUN_STATUS_PHRASES.map((phrase) => [runStatusPhraseKey(phrase.id), phrase[language]]));
}

/** Chinese catalog entries, spread into the zh-CN locale. */
export const runStatusMessagesZh: Record<string, string> = {
  "runStatus.live": "{phrase}，用时 {duration}",
  "runStatus.done": "已完成，用时 {duration}",
  ...phraseMessages("zh"),
};

/** English catalog entries, spread into the en locale. */
export const runStatusMessagesEn: Record<string, string> = {
  "runStatus.live": "{phrase} · {duration}",
  "runStatus.done": "Done in {duration}",
  ...phraseMessages("en"),
};

function phraseIndex(length: number, random: () => number): number {
  const raw = random();
  const unit = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0;
  return Math.min(length - 1, Math.floor(unit * length));
}

/**
 * Pick one phrase id for a turn. The same id stays on screen until the next
 * turn; pass the previous turn's id so two turns in a row do not match.
 */
export function pickRunStatusPhraseId(
  previousId: string | null | undefined,
  random: () => number = Math.random,
): RunStatusPhraseId {
  const pool = RUN_STATUS_PHRASES.filter((phrase) => phrase.id !== previousId);
  const candidates = pool.length > 0 ? pool : RUN_STATUS_PHRASES;
  return candidates[phraseIndex(candidates.length, random)].id;
}

export interface RunElapsedView {
  phraseId: string;
  startedAt: number;
  /** Null while the turn is running. Frozen milliseconds after it ends. */
  elapsedMs: number | null;
}

export interface RunElapsedMemory {
  view: RunElapsedView | null;
  previousPhraseId: string | null;
}

/**
 * Advance the visible turn. A running view keeps its phrase; a server start
 * time may replace the optimistic stamp without rolling a new line.
 */
export function settleRunElapsedView(input: {
  running: boolean;
  runStartedAt: number | null;
  now: number;
  view: RunElapsedView | null;
  previousPhraseId: string | null;
  random?: () => number;
}): RunElapsedMemory {
  const { running, runStartedAt, now, view, previousPhraseId } = input;
  const random = input.random ?? Math.random;

  if (running) {
    if (view && view.elapsedMs === null) {
      const startedAt = runStartedAt ?? view.startedAt;
      if (startedAt === view.startedAt) return { view, previousPhraseId };
      return { view: { ...view, startedAt }, previousPhraseId };
    }
    const phraseId = pickRunStatusPhraseId(previousPhraseId, random);
    return {
      view: {
        phraseId,
        startedAt: runStartedAt ?? now,
        elapsedMs: null,
      },
      previousPhraseId: phraseId,
    };
  }

  if (view && view.elapsedMs === null) {
    return {
      view: { ...view, elapsedMs: Math.max(0, now - view.startedAt) },
      previousPhraseId,
    };
  }

  return { view, previousPhraseId };
}
