export const RUNNING_STATUS_GENERATION_COUNT = 50;
export const RUNNING_STATUS_MAX_LABEL_LENGTH = 80;
export const RUNNING_STATUS_MAX_LABELS = 200;

const zh = [
  "凝思求解中", "梳理思路中", "认真推敲中", "拆解问题中", "整理线索中",
  "寻找切入点", "沿着思路前进", "把问题想清楚", "细细琢磨中", "汇拢零散思绪",
  "寻找合适的解法", "让思路慢慢清晰", "理顺前后关系", "换个角度想想", "继续往深处想",
  "逐步厘清问题", "琢磨关键细节", "把线索串起来", "寻找更稳妥的思路", "循着问题探索",
  "整理脑中的草稿", "给思路一点时间", "让答案逐渐成形", "往前再想一步", "斟酌其中的取舍",
  "把细节放回全局", "顺着线索推敲", "耐心寻找答案", "梳理问题的脉络", "思路酝酿中",
  "寻找关键的一环", "把复杂问题理顺", "沿着线索继续想", "让想法连贯起来", "仔细权衡中",
  "把问题拆小一点", "留意容易漏掉的细节", "继续整理想法", "让思路再走一会儿", "逐点推敲中",
  "理清需要关注的地方", "把想法慢慢展开", "寻找更清楚的表达", "思考合适的下一步", "让零散线索归位",
  "朝着答案靠近", "把来龙去脉想明白", "推敲更合适的方案", "继续探寻可行的思路", "认真想一想",
] as const;

const en = [
  "Working through it", "Sorting out the ideas", "Thinking it through", "Breaking down the question", "Gathering the threads",
  "Finding a starting point", "Following the idea", "Making sense of the question", "Giving it careful thought", "Bringing the pieces together",
  "Exploring an approach", "Letting the picture take shape", "Tracing the connections", "Considering another angle", "Thinking a little deeper",
  "Untangling the question", "Weighing the details", "Connecting the clues", "Considering a sound approach", "Exploring the possibilities",
  "Shaping a rough draft", "Giving the idea some room", "Letting an answer take shape", "Thinking one step ahead", "Considering the tradeoffs",
  "Putting details in context", "Following the thread", "Looking for an answer", "Tracing the bigger picture", "An idea is brewing",
  "Looking for the key detail", "Untangling the complexity", "Following another lead", "Making the ideas connect", "Weighing the possibilities",
  "Taking it piece by piece", "Considering the finer points", "Organizing the thoughts", "Following the thought further", "Thinking point by point",
  "Finding what matters", "Unfolding the idea", "Looking for a clearer expression", "Considering the next step", "Putting the clues in place",
  "Moving toward an answer", "Thinking through the context", "Considering a better approach", "Exploring a workable direction", "Taking a thoughtful moment",
] as const;

export function defaultRunningStatusLabels(locale: string): readonly string[] {
  return locale === "en" ? en : zh;
}

export function normalizeRunningStatusLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > RUNNING_STATUS_MAX_LABELS) throw new Error("invalid_labels");
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("invalid_labels");
    const label = raw.trim();
    if (!label) continue;
    if (Array.from(label).length > RUNNING_STATUS_MAX_LABEL_LENGTH || /[\r\n\u0000-\u001f]/.test(label)) throw new Error("invalid_label_length");
    if (!result.includes(label)) result.push(label);
  }
  return result;
}

export function parseGeneratedRunningStatusLabels(raw: string): string[] {
  if (raw.length > 32_000) throw new Error("invalid_generated_labels");
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  const parsed: unknown = JSON.parse(text);
  const labels = normalizeRunningStatusLabels(parsed);
  if (!Array.isArray(parsed) || parsed.length !== RUNNING_STATUS_GENERATION_COUNT || labels.length !== RUNNING_STATUS_GENERATION_COUNT) throw new Error("invalid_generated_labels");
  return labels;
}

/** A fresh task has a random command UUID. Hashing it samples the library while
 * keeping the same choice across clock ticks, retries, remounts and refreshes. */
export function pickRunningStatusLabel(labels: readonly string[], runKey: string): string {
  if (!labels.length) return "";
  let hash = 2166136261;
  for (const character of runKey) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return labels[(hash >>> 0) % labels.length];
}

export function runningStatusGenerationPrompt(locale: string): string {
  return `Write exactly 50 unique short running-status messages for Piora, an AI assistant. Language: ${locale === "en" ? "English" : "Simplified Chinese"}.
Use a calm, thoughtful and friendly tone. These are generic placeholders while a request is running: do not claim that a task has finished, that a check has passed, or that any specific tool is being used. Avoid promises, percentages, emoji, numbering and marketing language.
Keep each message concise (${locale === "en" ? "3–7 words" : "4–16 Chinese characters"}), with a maximum of 80 Unicode characters. Return only a JSON array of exactly 50 nonempty strings, with no Markdown or explanation.`;
}
