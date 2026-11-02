import type { BetaFeatures } from "./beta-feature-types";

/** App-owned metadata only: importing this catalog never loads an output runtime. */
export interface AnswerOutputDescriptor {
  kind: string;
  versions: readonly number[];
  tools: readonly string[];
  feature: keyof BetaFeatures;
  previewBytes: number;
}

export const ANSWER_OUTPUT_CATALOG: readonly AnswerOutputDescriptor[] = Object.freeze([
  Object.freeze({ kind: "intelligent-ui", versions: Object.freeze([1, 2]),
    tools: Object.freeze(["piora_render_ui", "piora_render_ui_plan"]), feature: "intelligentUi" as const, previewBytes: 64_000 }),
  Object.freeze({ kind: "mini-app", versions: Object.freeze([1]),
    tools: Object.freeze(["piora_render_mini_app"]), feature: "intelligentUi" as const, previewBytes: 128_000 }),
]);

export function answerOutputDescriptor(kind: string): AnswerOutputDescriptor | undefined {
  return ANSWER_OUTPUT_CATALOG.find(item => item.kind === kind);
}

export function answerOutputToolDescriptor(name: string): AnswerOutputDescriptor | undefined {
  return ANSWER_OUTPUT_CATALOG.find(item => item.tools.includes(name));
}
