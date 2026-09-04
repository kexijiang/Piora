import { NextResponse } from "next/server";

import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  ProjectToolSettingsConflictError,
  writeProjectToolSettings,
} from "@/lib/project-tool-settings";
import {
  buildProjectToolSelectionState,
  loadProjectToolsContext,
  type ProjectToolsContext,
} from "@/lib/project-tools";
import { applyProjectToolSettingsToLiveSessions } from "@/lib/rpc-manager";
import type { SessionCapabilityPreset, SessionCapabilitySelection } from "@/lib/session-capabilities";
import {
  estimateToolDefinitionPromptTokens,
  fitToolNamesWithinDefinitionBudget,
  TOOL_DEFINITION_PROMPT_TOKEN_LIMIT,
} from "@/lib/tool-definition-budget";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface PatchBody {
  cwd?: unknown;
  preset?: unknown;
  enabledCapabilityIds?: unknown;
  expectedRevision?: unknown;
}

async function assertAllowedCwd(cwd: string): Promise<void> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
}

function isPreset(value: unknown): value is SessionCapabilityPreset {
  return value === "chat" || value === "coding" || value === "research" || value === "device" || value === "custom";
}

function readSelection(body: PatchBody, context: ProjectToolsContext): SessionCapabilitySelection {
  if (!isPreset(body.preset)) throw new TypeError("Invalid project tool preset");
  if (body.preset !== "custom") return { preset: body.preset };
  if (!Array.isArray(body.enabledCapabilityIds)) throw new TypeError("enabledCapabilityIds is required for a custom preset");
  const ids = [...new Set(body.enabledCapabilityIds.filter((id): id is string => typeof id === "string"))];
  const availableIds = new Set(context.capabilities.items.map((item) => item.id));
  if (ids.some((id) => !availableIds.has(id))) throw new TypeError("Project tool selection contains an unavailable tool");
  return { preset: "custom", enabledCapabilityIds: ids };
}

function selectedToolNames(context: ProjectToolsContext, capabilities = context.capabilities): string[] {
  return capabilities.items.flatMap((item) => item.activeToolNames);
}

function publicState(
  context: ProjectToolsContext,
  options: {
    capabilities?: typeof context.capabilities;
    managed?: boolean;
    appliedSessions?: number;
    deferredSessions?: number;
    failedSessions?: number;
  } = {},
) {
  const capabilities = options.capabilities ?? context.capabilities;
  const names = new Set(selectedToolNames(context, capabilities));
  return {
    projectRoot: context.projectRoot,
    profile: context.profile,
    managed: options.managed ?? Boolean(context.record),
    capabilities,
    definitionTokens: estimateToolDefinitionPromptTokens(context.tools.filter((tool) => names.has(tool.name))),
    definitionTokenLimit: TOOL_DEFINITION_PROMPT_TOKEN_LIMIT,
    diagnostics: context.diagnostics,
    ...(options.appliedSessions === undefined ? {} : { appliedSessions: options.appliedSessions }),
    ...(options.deferredSessions === undefined ? {} : { deferredSessions: options.deferredSessions }),
    ...(options.failedSessions === undefined ? {} : { failedSessions: options.failedSessions }),
  };
}

export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim();
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    await assertAllowedCwd(cwd);
    return NextResponse.json(publicState(await loadProjectToolsContext(cwd)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: PatchBody;
  try {
    body = await request.json() as PatchBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return NextResponse.json({ error: "cwd and a non-negative expectedRevision are required" }, { status: 400 });
  }

  try {
    await assertAllowedCwd(cwd);
    const context = await loadProjectToolsContext(cwd);
    const expectedRevision = Number(body.expectedRevision);
    if (context.capabilities.policy.revision !== expectedRevision) {
      return NextResponse.json({
        error: "Project tools changed in another view. Refresh and try again.",
        currentRevision: context.capabilities.policy.revision,
      }, { status: 409 });
    }
    const selection = readSelection(body, context);
    const preview = buildProjectToolSelectionState(context, selection, expectedRevision + 1);
    const names = selectedToolNames(context, preview);
    const budget = fitToolNamesWithinDefinitionBudget(context.tools, names);
    if (budget.droppedToolNames.length > 0) {
      return NextResponse.json({
        error: `Tool definitions exceed the ${TOOL_DEFINITION_PROMPT_TOKEN_LIMIT.toLocaleString("en-US")} token project limit. Disable another tool first.`,
        droppedToolNames: budget.droppedToolNames,
      }, { status: 409 });
    }

    const record = writeProjectToolSettings(context.projectRoot, selection, expectedRevision);
    const capabilities = buildProjectToolSelectionState(context, selection, record.revision);
    const live = applyProjectToolSettingsToLiveSessions(context.projectRoot, record);
    return NextResponse.json(publicState(context, {
      capabilities,
      managed: true,
      ...live,
    }));
  } catch (error) {
    if (error instanceof ProjectToolSettingsConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Access denied" ? 403 : error instanceof TypeError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
