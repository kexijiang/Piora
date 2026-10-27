import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { generateUnifiedPatch, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileToolGuidance } from "../lib/file-tool-guidance.ts";

const MAX_CAPTURE_BYTES = 512 * 1024;

type ChangeKind = "created" | "updated" | "unchanged";

interface PendingWrite {
  displayPath: string;
  absolutePath: string;
  nextContent: string;
  previousContent?: string;
  existed: boolean;
  unavailableReason?: "too_large" | "binary" | "unreadable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function captureWrite(
  cwd: string,
  input: Record<string, unknown>,
): Promise<PendingWrite | null> {
  const displayPath = typeof input.path === "string" ? input.path : "";
  const nextContent = typeof input.content === "string" ? input.content : null;
  if (!displayPath || nextContent === null) return null;

  const absolutePath = isAbsolute(displayPath) ? resolve(displayPath) : resolve(cwd, displayPath);
  if (Buffer.byteLength(nextContent, "utf8") > MAX_CAPTURE_BYTES) {
    try {
      const metadata = await stat(absolutePath);
      return { displayPath, absolutePath, nextContent, existed: metadata.isFile(), unavailableReason: "too_large" };
    } catch (error) {
      return {
        displayPath,
        absolutePath,
        nextContent,
        existed: errorCode(error) !== "ENOENT",
        unavailableReason: "too_large",
      };
    }
  }

  try {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      return { displayPath, absolutePath, nextContent, existed: true, unavailableReason: "unreadable" };
    }
    if (metadata.size > MAX_CAPTURE_BYTES) {
      return { displayPath, absolutePath, nextContent, existed: true, unavailableReason: "too_large" };
    }
    const previous = await readFile(absolutePath);
    if (previous.includes(0)) {
      return { displayPath, absolutePath, nextContent, existed: true, unavailableReason: "binary" };
    }
    return {
      displayPath,
      absolutePath,
      nextContent,
      previousContent: previous.toString("utf8"),
      existed: true,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { displayPath, absolutePath, nextContent, previousContent: "", existed: false };
    }
    return { displayPath, absolutePath, nextContent, existed: false, unavailableReason: "unreadable" };
  }
}

function writeResultDetails(snapshot: PendingWrite): Record<string, unknown> {
  const base = {
    path: snapshot.displayPath,
    changeKind: snapshot.existed ? "updated" as ChangeKind : "created" as ChangeKind,
  };
  if (snapshot.unavailableReason || snapshot.previousContent === undefined) {
    return { ...base, fileChangeUnavailable: snapshot.unavailableReason ?? "unreadable" };
  }

  const patch = generateUnifiedPatch(snapshot.displayPath, snapshot.previousContent, snapshot.nextContent);
  return {
    ...base,
    patch,
    changeKind: patch ? base.changeKind : "unchanged" as ChangeKind,
  };
}

export default function pioraFileChanges(api: ExtensionAPI) {
  const pendingWrites = new Map<string, PendingWrite>();

  api.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes("<piora_file_tools>")) return;
    const hidden = new Set(event.systemPromptOptions.hiddenTools ?? []);
    const guidance = fileToolGuidance((event.systemPromptOptions.selectedTools ?? []).filter(name => !hidden.has(name)));
    if (guidance) return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  api.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    const snapshot = await captureWrite(ctx.cwd, event.input);
    if (snapshot) pendingWrites.set(event.toolCallId, snapshot);
  });

  api.on("tool_result", (event) => {
    if (event.toolName !== "write") return;
    const snapshot = pendingWrites.get(event.toolCallId);
    pendingWrites.delete(event.toolCallId);
    if (!snapshot || event.isError) return;
    return { details: writeResultDetails(snapshot) };
  });

  api.on("tool_execution_end", (event) => {
    pendingWrites.delete(event.toolCallId);
  });
}
