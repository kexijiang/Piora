import { APP_DISPLAY_NAME } from "../lib/branding.ts";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeUserInputAnswers,
  normalizeUserInputQuestions,
  userInputTimeoutMs,
  type UserInputQuestion,
  type UserInputResult,
} from "../lib/user-input.ts";

type PioraUi = ExtensionContext["ui"] & {
  requestUserInput?: (
    title: string,
    description: string | undefined,
    questions: UserInputQuestion[],
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<UserInputResult>;
};

async function fallbackRequest(
  ctx: ExtensionContext,
  questions: UserInputQuestion[],
  timeout: number,
  signal?: AbortSignal,
): Promise<UserInputResult> {
  const expiresAt = Date.now() + timeout;
  const cancelled = (): UserInputResult => signal?.aborted || Date.now() < expiresAt
    ? { cancelled: true } : { cancelled: true, reason: "timeout" };
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    if (signal?.aborted) return { cancelled: true };
    if (Date.now() >= expiresAt) return cancelled();
    const options = { signal, timeout: expiresAt - Date.now() };
    const title = question.header || question.question;
    if (question.kind === "single_select") {
      const value = await ctx.ui.select(title, question.options!.map((option) => option.label), options);
      if (value === undefined || Date.now() >= expiresAt) return cancelled();
      answers[question.id] = [value];
      continue;
    }
    if (question.kind === "multi_select") {
      const labels = question.options!.map((option) => option.label);
      const value = await ctx.ui.input(`${title} (${labels.join(", ")})`, "Enter one or more labels separated by commas", options);
      if (value === undefined || Date.now() >= expiresAt) return cancelled();
      answers[question.id] = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    // The SDK's terminal editor has no timeout/signal support; input does.
    const value = await ctx.ui.input(title, question.placeholder, options);
    if (value === undefined || Date.now() >= expiresAt) return cancelled();
    answers[question.id] = value.trim() ? [value.trim()] : [];
  }
  return { answers };
}

export default function pioraUserInput(api: ExtensionAPI) {
  api.registerTool(defineTool({
    name: "piora_request_user_input",
    label: "Ask User",
    description: `Show a native ${APP_DISPLAY_NAME} question card and wait up to 60 seconds by default for a structured response. Supports up to three single-choice, multiple-choice, or text questions in one call. Unanswered cards time out so work can continue.`,
    promptSnippet: `Ask focused questions through ${APP_DISPLAY_NAME}'s native user-input card instead of burying choices in ordinary chat text`,
    promptGuidelines: [
      "Use this tool when the user's answer changes the implementation, scope, preference, or next action and cannot be safely inferred.",
      "Prefer one call with all closely related questions (maximum three). Keep headers short, questions concrete, and options mutually distinct.",
      "Use single_select for one decision, multi_select when several choices may apply, and text only when predefined options would be misleading.",
      "Do not request passwords, API keys, tokens, payment details, or other secrets.",
      "Do not use this tool for rhetorical questions, routine progress updates, or confirmations that are already explicit in the user's request.",
      "Wait for the tool result before continuing. If the user cancels, do not invent an answer.",
      "On timeout, continue work supported by existing instructions, stating any assumptions. Do not treat silence as consent, submit defaults, or immediately repeat the same questions. If an answer is essential, explain the blocked part and continue independent work.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 120, description: "Short title for the card." })),
      description: Type.Optional(Type.String({ maxLength: 500, description: "Why this input is needed." })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 300, description: "Time to answer the whole card; defaults to 60 seconds. Allow more time for complex or free-text questions." })),
      questions: Type.Array(Type.Object({
        id: Type.String({ maxLength: 64, description: "Stable identifier used in the returned answers." }),
        header: Type.Optional(Type.String({ maxLength: 40, description: "Short section label." })),
        question: Type.String({ maxLength: 500 }),
        kind: Type.Union([Type.Literal("single_select"), Type.Literal("multi_select"), Type.Literal("text")]),
        options: Type.Optional(Type.Array(Type.Object({
          label: Type.String({ maxLength: 100 }),
          description: Type.Optional(Type.String({ maxLength: 300 })),
        }), { minItems: 2, maxItems: 6 })),
        placeholder: Type.Optional(Type.String({ maxLength: 240 })),
        multiline: Type.Optional(Type.Boolean()),
        required: Type.Optional(Type.Boolean()),
      }), { minItems: 1, maxItems: 3 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeUserInputQuestions(params.questions);
      const ui = ctx.ui as PioraUi;
      const timeout = userInputTimeoutMs(params.timeoutSeconds === undefined ? undefined : params.timeoutSeconds * 1000);
      const result = ui.requestUserInput
        ? await ui.requestUserInput(
          params.title?.trim() || "Your input is needed",
          params.description?.trim() || undefined,
          questions,
          { signal, timeout },
        )
        : await fallbackRequest(ctx, questions, timeout, signal);
      if ("cancelled" in result) {
        if (result.reason === "timeout") return {
          content: [{ type: "text" as const, text: "The question card timed out without a submitted response. No answers or consent were provided. Continue work supported by existing instructions and state any assumptions; do not immediately ask the same questions again. If an answer is essential, explain the blocked part and continue independent work." }],
          details: { cancelled: true, reason: "timeout" },
        };
        return {
          content: [{ type: "text" as const, text: "The user cancelled the question card without submitting answers. Do not infer their choices." }],
          details: { cancelled: true },
        };
      }
      const answers = normalizeUserInputAnswers(questions, result.answers);
      const lines = questions.map((question) => {
        const values = answers[question.id] ?? [];
        return `- ${question.id}: ${values.length > 0 ? values.join(", ") : "(skipped)"}`;
      });
      return {
        content: [{ type: "text" as const, text: `The user submitted the question card:\n${lines.join("\n")}` }],
        details: { cancelled: false, answers },
      };
    },
  }));

  api.on?.("before_agent_start", (event) => {
    if (!event.systemPromptOptions.selectedTools?.includes("piora_request_user_input")) return;
    if (event.systemPrompt.includes('<piora_runtime_capability name="user_input_card"')) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n<piora_runtime_capability name="user_input_card" availability="active">
${APP_DISPLAY_NAME} can display a native interactive question card through the \`piora_request_user_input\` tool and return the user's structured answers. When you genuinely need the user to choose among options, select multiple applicable items, or provide missing text before continuing, prefer this tool over an unstructured list of questions in ordinary chat. Ask no more than three focused questions per call, do not request secrets, wait for the result, and never invent an answer after cancellation. Cards time out after 60 seconds by default (timeoutSeconds: 30–300). After timeout, continue work supported by existing instructions, state assumptions, and do not immediately repeat the same questions. Silence is not consent; explain any essential missing information instead of guessing it.
</piora_runtime_capability>`,
    };
  });
}
