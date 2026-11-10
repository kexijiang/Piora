import { createChatCommandCatalog, createChatCommandOperation, parseChatInput } from "./chat-command-input";
import { getRpcSession } from "./rpc-manager";
import { resolveOrStartRpcSession } from "./session-runtime-resolver";
import { getSessionMessageRouter, SessionMessageRouterError } from "./session-message-router";
import { resolveSessionAgentRuntimeProfile } from "./agent-profile-store";
import { getAgentRuntimeProfile } from "./agent-runtime-profile";
import type { ChatCommandCatalog, ChatInputOptions } from "./chat-command-types";
import type { SessionMessageImage } from "./session-message-types";
import type { PromptMaterialReference } from "./prompt-material-format";
import { buildLocalFilePrompt } from "./file-attachments";

export class ChatInputDispatchError extends Error {
  constructor(readonly code: string, readonly commandName: string, readonly status = 400) {
    super(`${code}${commandName ? `: /${commandName}` : ""}`);
  }
}

export async function dispatchChatInput(sessionId: string, body: Record<string, unknown>) {
  if (typeof body.message !== "string" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 512) throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  if (body.inputMode !== undefined && body.inputMode !== "auto" && body.inputMode !== "text") throw new ChatInputDispatchError("INVALID_INPUT_MODE", "");
  if (body.delivery !== undefined && !["next_turn", "steer", "followUp"].includes(body.delivery as string)) throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  if (body.promptSuffix !== undefined && (typeof body.promptSuffix !== "string" || Buffer.byteLength(body.promptSuffix, "utf8") + Buffer.byteLength(body.message, "utf8") > 256 * 1024)) throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  if (body.localFiles !== undefined && (!Array.isArray(body.localFiles) || body.localFiles.length > 8 || body.localFiles.some(file => !file || typeof file.name !== "string" || typeof file.path !== "string" || !file.path || file.path.length > 32768 || !Number.isFinite(file.size) || file.size < 0))) throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  const localFiles = body.localFiles as Array<{ name: string; size: number; path: string }> | undefined;
  const promptSuffix = localFiles?.length ? buildLocalFilePrompt("", localFiles.map(file => ({ ...file, text: null }))) : body.promptSuffix as string | undefined;
  for (const field of ["commandKey", "catalogRevision", "afterPrompt"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  }
  if (Buffer.byteLength(body.message, "utf8") + Buffer.byteLength(typeof body.afterPrompt === "string" ? body.afterPrompt : "", "utf8") + Buffer.byteLength(promptSuffix ?? "", "utf8") > 256 * 1024) throw new ChatInputDispatchError("SESSION_MESSAGE_TOO_LARGE", "", 413);
  if (body.rawText !== undefined && (typeof body.rawText !== "string" || Buffer.byteLength(body.rawText, "utf8") > 256 * 1024)) throw new ChatInputDispatchError("INVALID_SESSION_MESSAGE", "");
  const runtimeProfile = getAgentRuntimeProfile();
  await resolveSessionAgentRuntimeProfile(sessionId, runtimeProfile);
  const router = getSessionMessageRouter();
  const previous = await router.findSubmissionReceipt(sessionId, body.idempotencyKey);
  if (previous) return previous;
  const input = { targetSessionId: sessionId, source: "ui" as const, idempotencyKey: body.idempotencyKey,
    content: body.message,
    ...(promptSuffix ? { promptSuffix } : {}),
    ...(localFiles?.length ? { localFiles } : {}),
    ...(body.inputMode === "text" ? { inputMode: "text" as const } : {}),
    ...(Array.isArray(body.images) ? { images: body.images as SessionMessageImage[] } : {}),
    ...(Array.isArray(body.materials) ? { materials: body.materials as PromptMaterialReference[] } : {}),
  };
  let catalog = createChatCommandCatalog([]);
  const name = body.message.trimStart().match(/^\/([^\s]+)/)?.[1];
  const builtin = catalog.commands.find(command => command.name === name && command.supported);
  if (body.inputMode !== "text" && name && !builtin) {
    const session = getRpcSession(sessionId) ?? (await resolveOrStartRpcSession(sessionId, { runtimeProfile })).session;
    const result = await session.send({ type: "get_commands" }) as { catalog: ChatCommandCatalog };
    catalog = result.catalog;
    if (body.catalogRevision !== undefined && body.catalogRevision !== catalog.revision) throw new ChatInputDispatchError("COMMAND_CATALOG_CHANGED", name, 409);
  }
  const parsed = parseChatInput(body.message, catalog, { inputMode: body.inputMode as ChatInputOptions["inputMode"], commandKey: body.commandKey as string | undefined,
    afterPrompt: body.afterPrompt as string | undefined, hasAttachments: Boolean(input.images?.length || input.materials?.length || input.promptSuffix) });
  if (parsed.kind === "invalid") throw new ChatInputDispatchError(parsed.code, parsed.name);
  if (parsed.kind === "command") {
    const operation = createChatCommandOperation(typeof body.rawText === "string" ? body.rawText : body.message, catalog, parsed, { ...(typeof body.afterPrompt === "string" ? { afterPrompt: body.afterPrompt } : {}), ...(body.delivery ? { delivery: body.delivery as ChatInputOptions["delivery"] } : {}) });
    return router.dispatchSessionMessage({ ...input, delivery: "next_turn", operation });
  }
  if (!input.content.trim() && !input.images?.length && !input.materials?.length) throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "Message cannot be empty");
  // Classification is complete. Keep literal input literal for every delivery mode.
  input.inputMode = "text";
  if (body.delivery === "steer") return router.steerSession(input);
  if (body.delivery === "followUp") return router.followUpSession(input);
  return router.dispatchSessionMessage({ ...input, delivery: "next_turn" });
}
