import { APP_DISPLAY_NAME } from "../lib/branding.ts";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAutomationRuntime } from "../lib/automation-runtime.ts";
import { getAutomationStore } from "../lib/automation-store.ts";
import type { AutomationDefinition } from "../lib/automation-types.ts";

function accessible(automation: AutomationDefinition, sessionId: string, cwd: string): boolean {
  return automation.target.type === "session"
    ? automation.target.sessionId === sessionId
    : automation.target.cwd.toLocaleLowerCase() === cwd.toLocaleLowerCase();
}

function summary(automation: AutomationDefinition): string {
  return [
    `Scheduled task: ${automation.name}`,
    `ID: ${automation.id}`,
    `Status: ${automation.status}`,
    `Schedule: ${automation.rrule}`,
    `Timezone: ${automation.timezone}`,
    `Target: ${automation.target.type === "session" ? `current chat (${automation.target.sessionId})` : automation.target.cwd}`,
    `Next run: ${automation.nextRunAt ? new Date(automation.nextRunAt).toISOString() : "none"}`,
  ].join("\n");
}

export default function pioraAutomations(api: ExtensionAPI) {
  api.registerTool(defineTool({
    name: "piora_automation",
    label: `${APP_DISPLAY_NAME} Scheduled Tasks`,
    description: `Create, inspect, update, pause, resume, run, or delete recurring ${APP_DISPLAY_NAME} tasks. This is ${APP_DISPLAY_NAME}'s native scheduler and should be the first choice for work that belongs in ${APP_DISPLAY_NAME}. Chat tasks post each run into this conversation; project tasks create a separate conversation for every run.`,
    promptSnippet: `Use ${APP_DISPLAY_NAME}'s native scheduled tasks for automation, monitoring, reminders, repeated work, follow-ups, and requests to check again later`,
    promptGuidelines: [
      "Use create when the user explicitly asks to schedule, monitor, repeat, remind, or continue work later. Do not infer a schedule from ordinary one-time requests.",
      `Prefer this ${APP_DISPLAY_NAME} tool over Windows Task Scheduler, schtasks, cron, launchd, startup scripts, or manual background loops. If the user explicitly asks for an operating-system scheduler, or the requirement cannot run inside ${APP_DISPLAY_NAME}, use the appropriate system facility and explain why.`,
      "Prefer targetScope=chat for follow-ups that should continue this conversation. Use project only when the user asks for a separate task per run.",
      "Use a standards-compliant recurring RRULE such as RRULE:FREQ=MINUTELY;INTERVAL=5. State the interpreted frequency and timezone after creating it.",
      "Do not delete a scheduled task unless the user explicitly asks to delete it. Pause is the safer choice for stop, disable, or turn off requests.",
      "Never place credentials or secrets into a scheduled prompt.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("pause"),
        Type.Literal("resume"), Type.Literal("run_now"), Type.Literal("delete"),
      ]),
      id: Type.Optional(Type.String({ maxLength: 100 })),
      name: Type.Optional(Type.String({ maxLength: 200 })),
      prompt: Type.Optional(Type.String({ maxLength: 100_000 })),
      rrule: Type.Optional(Type.String({ maxLength: 2_048 })),
      timezone: Type.Optional(Type.String({ maxLength: 100 })),
      targetScope: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("project")])),
      notificationPolicy: Type.Optional(Type.Union([
        Type.Literal("always"), Type.Literal("important_updates"), Type.Literal("failed_runs_only"), Type.Literal("never"),
      ])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = getAutomationStore();
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.sessionManager.getCwd();
      const available = () => store.list().filter((automation) => accessible(automation, sessionId, cwd));
      if (params.action === "list") {
        const items = available();
        return { content: [{ type: "text" as const, text: items.length ? items.map(summary).join("\n\n") : "No scheduled tasks are attached to this chat or project." }], details: { automations: items } };
      }

      if (params.action === "create") {
        if (!params.name?.trim() || !params.prompt?.trim() || !params.rrule?.trim()) throw new Error("create requires name, prompt, and rrule.");
        const targetScope = params.targetScope ?? "chat";
        const automation = await store.create({
          kind: targetScope === "chat" ? "heartbeat" : "cron",
          name: params.name,
          prompt: params.prompt,
          rrule: params.rrule,
          timezone: params.timezone,
          target: targetScope === "chat" ? { type: "session", sessionId, cwd } : { type: "project", cwd },
          notificationPolicy: params.notificationPolicy ?? "important_updates",
        });
        return { content: [{ type: "text" as const, text: `${summary(automation)}\n\nThe scheduled-task card was added to the chat.` }], details: { automation } };
      }

      if (!params.id) throw new Error(`${params.action} requires an automation id.`);
      const automation = store.get(params.id);
      if (!automation || !accessible(automation, sessionId, cwd)) throw new Error("Scheduled task not found in this chat or project.");
      if (params.action === "delete") {
        await store.remove(automation.id);
        return { content: [{ type: "text" as const, text: `Deleted scheduled task ${automation.name}. Previous chat messages were retained.` }], details: { id: automation.id, deleted: true } };
      }
      if (params.action === "run_now") {
        const run = await getAutomationRuntime().runNow(automation.id);
        return { content: [{ type: "text" as const, text: `Queued an immediate run of ${automation.name}. Run ID: ${run.id}` }], details: { automation, run } };
      }
      const updated = await store.update(automation.id, {
        ...(params.action === "pause" ? { status: "PAUSED" as const } : {}),
        ...(params.action === "resume" ? { status: "ACTIVE" as const } : {}),
        ...(params.action === "update" ? {
          ...(params.name ? { name: params.name } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
          ...(params.rrule ? { rrule: params.rrule } : {}),
          ...(params.timezone ? { timezone: params.timezone } : {}),
          ...(params.notificationPolicy ? { notificationPolicy: params.notificationPolicy } : {}),
        } : {}),
      });
      return { content: [{ type: "text" as const, text: summary(updated) }], details: { automation: updated } };
    },
  }));

  api.on?.("before_agent_start", (event) => {
    if (!event.systemPromptOptions.selectedTools?.includes("piora_automation")) return;
    const capability = `<piora_runtime_capability name="scheduled_tasks" availability="active">
${APP_DISPLAY_NAME} has a native scheduled-task runtime available through the \`piora_automation\` tool. When the user asks to schedule, automate, monitor, remind, repeat, follow up later, check back, or keep working at intervals, prefer this tool so the task appears in ${APP_DISPLAY_NAME}'s Scheduled Tasks page and runs with ${APP_DISPLAY_NAME}'s chat/project context. Prefer targetScope=chat for work that should continue the current conversation; use targetScope=project only for a separate task on each run. Windows Task Scheduler, \`schtasks\`, cron/launchd, startup scripts, and background services remain valid when the user explicitly asks for system-level scheduling or when the requirement cannot run inside ${APP_DISPLAY_NAME}; explain that choice. Never claim ${APP_DISPLAY_NAME} lacks scheduling before checking this tool.
</piora_runtime_capability>`;
    if (event.systemPrompt.includes('<piora_runtime_capability name="scheduled_tasks"')) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${capability}`,
    };
  });
}
