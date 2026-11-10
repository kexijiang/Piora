import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { summarizeSessionStats } from "./session-stats";
import { persistLazySessionManager } from "./session-persistence";
import type { SessionCommandRecord } from "./session-message-types";
import type { ChatCommandCatalog, ChatCommandPhase, ChatCommandResult } from "./chat-command-types";
import { readWorkflowSnapshot, WorkflowError } from "./workflow-runtime";

export interface ChatCommandExecutionContext {
  session?: AgentSessionWrapper;
  assertActive(): void;
  phase(phase: ChatCommandPhase): void;
  prompt(message: string): Promise<void>;
  copy(text: string): Promise<void>;
}

export async function executeChatCommandOperation(record: SessionCommandRecord, context: ChatCommandExecutionContext): Promise<ChatCommandResult> {
  const operation = record.operation!;
  const descriptor = operation.command;
  const session = context.session;
  context.assertActive();
  if (descriptor.source === "extension") {
    if (!session) throw new Error("Session runtime is unavailable");
    const workflow = readWorkflowSnapshot(session.sessionId);
    if ((record.workflow?.mode ?? workflow.mode) !== "agent") throw new WorkflowError("Switch to Agent mode before running an extension command.", "WORKFLOW_EXTENSION_COMMAND", 409);
    if (workflow.mode !== "agent") {
      await session.send({ type: "workflow_configure", workflow: { mode: "agent" }, expectedRevision: workflow.revision });
      context.assertActive();
    }
    const details: string[] = [], warnings: string[] = [];
    const unsubscribe = session.onEvent(event => {
      if (event.type !== "extension_ui_request" || event.method !== "notify" || event.commandId !== record.commandId || typeof event.message !== "string") return;
      (event.notifyType === "warning" ? warnings : details).push(event.message);
    });
    try {
      await session.executeChatCommand(record.commandId, `/${descriptor.name}${operation.arguments ? ` ${operation.arguments}` : ""}`, context.phase);
      return { title: "chatCommands.extensionCompleted", ...(details.length ? { details } : {}), ...(warnings.length ? { warnings } : {}) };
    } finally { unsubscribe(); }
  }
  if (descriptor.source === "prompt" || descriptor.source === "skill") {
    context.phase("model");
    const invocation = `/${descriptor.name}${operation.arguments ? ` ${operation.arguments}` : ""}`;
    const delivery = operation.inputOptions?.delivery;
    if (delivery === "steer" || delivery === "followUp") {
      if (!session) throw new Error("Session runtime is unavailable");
      await session.executeModelCommand(record.commandId, invocation, { delivery, ...(!operation.afterPrompt ? { images: record.images, materials: record.materials, promptSuffix: record.promptSuffix } : {}) }, context.phase);
    } else await context.prompt(invocation);
    return { title: "chatCommands.promptCompleted" };
  }
  const path = !session && (descriptor.name === "session" || descriptor.name === "copy") ? await resolveSessionPath(record.targetSessionId) : undefined;
  const manager = session?.inner.sessionManager ?? (path ? SessionManager.open(path) : undefined);
  if (descriptor.name === "session") {
    if (!manager) throw new Error("Session not found");
    return { title: "chatCommands.statsReady", stats: summarizeSessionStats(manager) };
  }
  if (descriptor.name === "copy") {
    if (!manager) throw new Error("Session not found");
    const message = [...manager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error");
    const text = message?.type === "message" && message.message.role === "assistant"
      ? message.message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim() : "";
    if (!text) throw new Error("No completed assistant message to copy");
    await context.copy(text);
    return { title: "chatCommands.copyCompleted", details: [String(text.length)] };
  }
  if (!session) throw new Error("Session runtime is unavailable");
  if (descriptor.name === "reload") {
    await session.send({ type: "reload" });
    context.assertActive();
    const result = await session.send({ type: "get_commands" }) as { catalog: ChatCommandCatalog };
    const extensions = session.inner.resourceLoader.getExtensions();
    persistLazySessionManager(session.inner.sessionManager);
    return {
      title: "chatCommands.reloadCompleted",
      message: "chatCommands.reloadUpdated",
      resources: { extensions: extensions.extensions.length, skills: session.inner.resourceLoader.getSkills().skills.length, prompts: session.inner.promptTemplates.length, commands: result.catalog.commands.filter(command => command.supported).length },
      ...(extensions.errors.length ? { warnings: extensions.errors.map(error => `${error.path}: ${error.error}`) } : {}),
    };
  }
  if (descriptor.name === "name") {
    const before = session.inner.sessionManager.getSessionName();
    const after = operation.arguments.trim();
    await session.send({ type: "set_session_name", name: after });
    persistLazySessionManager(session.inner.sessionManager);
    return { title: "chatCommands.renameCompleted", rename: { before, after } };
  }
  if (descriptor.name === "compact") {
    const result = await session.send({ type: "compact", ...(operation.arguments.trim() ? { customInstructions: operation.arguments } : {}) }) as { summary?: string; tokensBefore?: number } | undefined;
    persistLazySessionManager(session.inner.sessionManager);
    return { title: result ? "chatCommands.compactCompleted" : "chatCommands.compactUnchanged", ...(result ? { compact: { summary: result.summary, tokensBefore: result.tokensBefore, tokensAfter: session.inner.getContextUsage()?.tokens ?? undefined } } : {}) };
  }
  throw new Error(`Unsupported command: /${descriptor.name}`);
}
