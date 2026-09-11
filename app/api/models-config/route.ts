import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateServicesCache } from "@/lib/rpc-manager";
import { normalizeModelConfigCosts } from "@/lib/model-config-cost";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(strict = false): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (strict) throw error;
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
}

export async function GET() {
  return NextResponse.json(readModelsJson());
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = normalizeModelConfigCosts(await req.json());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
  try {
    writeModelsJson(body);
    invalidateModelsCache();
    invalidateServicesCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let target: { provider: string; id?: string };
  try {
    const body = await req.json();
    if (!body || typeof body.provider !== "string" || !body.provider.trim()
      || (body.id !== undefined && (typeof body.id !== "string" || !body.id.trim()))) {
      return NextResponse.json({ error: "请指定要删除的渠道或模型。" }, { status: 400 });
    }
    target = body;
  } catch {
    return NextResponse.json({ error: "删除请求格式不正确。" }, { status: 400 });
  }
  try {
    // Read the latest file and change only the requested entry. Deleting must
    // neither save unrelated form drafts nor overwrite an unreadable config.
    const config = readModelsJson(true);
    const providers = config.providers as Record<string, { models?: Array<{ id: string }> }> | undefined;
    if (providers && Object.hasOwn(providers, target.provider)) {
      if (target.id === undefined) delete providers[target.provider];
      else {
        const provider = providers[target.provider];
        provider.models = provider.models?.filter(model => model.id !== target.id);
        if (!provider.models?.length) delete provider.models;
      }
      writeModelsJson(config);
    }
    const savedProviders = readModelsJson(true).providers as typeof providers;
    const savedProvider = savedProviders && Object.hasOwn(savedProviders, target.provider) ? savedProviders[target.provider] : undefined;
    if (target.id === undefined ? savedProvider !== undefined : savedProvider?.models?.some(model => model.id === target.id)) {
      throw new Error("删除结果尚未写入配置，请检查文件是否被其他程序修改。");
    }
    invalidateModelsCache();
    invalidateServicesCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: `无法完成删除，配置未确认更新：${String(error)}` }, { status: 500 });
  }
}
