import { NextResponse } from "next/server";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  applyExtensionLoadPlan,
  buildExtensionInventoryFromPlan,
  resolveExtensionLoadPlan,
  setExtensionEnabled,
  type ExtensionsResponse,
} from "@/lib/extension-config";
import { invalidateServicesCache } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function assertAllowedCwd(cwd: string): Promise<void> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
}

async function readExtensions(cwd: string, reloadRequired = false): Promise<ExtensionsResponse> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const plan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal" });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: plan.enabledPaths,
    noExtensions: true,
    extensionsOverride: (result) => applyExtensionLoadPlan(result, plan),
  });
  await loader.reload();
  const result = loader.getExtensions();
  return {
    extensions: buildExtensionInventoryFromPlan(plan, result.extensions),
    diagnostics: result.errors,
    ...(reloadRequired ? { reloadRequired: true } : {}),
  };
}

export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim();
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    await assertAllowedCwd(cwd);
    return NextResponse.json(await readExtensions(cwd));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { cwd?: unknown; id?: unknown; enabled?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!cwd || !id || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "cwd, id, and enabled are required" }, { status: 400 });
    }
    await assertAllowedCwd(cwd);
    const current = await readExtensions(cwd);
    const extension = current.extensions.find((item) => item.id === id);
    if (!extension) {
      return NextResponse.json({ error: "Extension not found" }, { status: 404 });
    }
    if (!extension.configurable) {
      return NextResponse.json({
        error: extension.required
          ? "This extension is a required Piora core capability"
          : "This extension is controlled by its package plugin setting",
      }, { status: 409 });
    }
    setExtensionEnabled(id, body.enabled);
    if (id === "piora:computer") {
      const { getComputerControl } = await import("@/lib/computer-control");
      if (body.enabled) getComputerControl().resume(); else await getComputerControl().stop();
    }
    invalidateServicesCache();
    return NextResponse.json(await readExtensions(cwd, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}
