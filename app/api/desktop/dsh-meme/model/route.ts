import { requireHarmonyDesktopAccess } from "../../../harmony/_shared";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { createTrustedModelServices, resolveModelRequestCwd } from "@/lib/model-runtime-context";
import { resolveVisibleModels } from "@/lib/model-scope";
import { modelSupportsImages } from "@/lib/model-capabilities";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
export async function POST(request: Request) {
  const denied = requireHarmonyDesktopAccess(request); if (denied) return denied;
  try {
    const input = await parseJsonWithinLimit(request, 24 * 1024 * 1024) as { action: string; selection?: { provider?: string; model?: string; cwd?: string }; messages?: { content: { type: string; text?: string; attachment?: { data?: string; mediaType?: string } }[] }[] };
    const cwd = await resolveModelRequestCwd(input.selection?.cwd);
    const services = await createTrustedModelServices(cwd);
    const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
    const requested = input.selection?.provider && input.selection.provider !== "piora";
    const model = requested ? scope.visible.find(model => model.provider === input.selection?.provider && model.id === input.selection?.model) : scope.visible[0];
    if (!model || !modelSupportsImages(model)) throw new Error("当前模型不可用或不支持图片，请选择支持图片的模型，或手动指定分类。");
    if (input.action === "check") return Response.json({ value: true });
    if (input.action !== "complete") throw new Error("Invalid model action");
    const content: (TextContent | ImageContent)[] = [];
    for (const part of input.messages?.[0]?.content || []) {
      if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text.slice(0, 16000) });
      if (part.type === "image" && typeof part.attachment?.data === "string" && part.attachment.data.length <= 12 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(part.attachment.mediaType || "")) content.push({ type: "image", data: part.attachment.data, mimeType: part.attachment.mediaType! });
    }
    if (!content.some(part => part.type === "image")) throw new Error("No valid image");
    const result = await services.modelRuntime.completeSimple(model, { messages: [{ role: "user", content, timestamp: Date.now() }] }, { maxTokens: 4096, maxRetries: 0, timeoutMs: 110000, signal: request.signal });
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "Image recognition failed");
    return Response.json({ value: result.content.filter(part => part.type === "text").map(part => part.text).join("") });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Image recognition failed" }, { status: 400 }); }
}
