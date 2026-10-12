import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { apiError, body, guard, requiredString } from "@/lib/skill-sources/api";
import { fetchCatalog } from "@/lib/skill-sources/adapters";
import { catalogPage } from "@/lib/skill-sources/catalog";
import { getSource, listSources, normalizeInput, recordSourceStatus, removeSource, saveSource, sourceCredential, sourceIdentity } from "@/lib/skill-sources/store";
import { SkillSourceError, type SkillSource, type SourceInput } from "@/lib/skill-sources/types";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try { guard(req); return NextResponse.json({ sources: listSources() }); } catch (error) { return apiError(error); }
}
export async function POST(req: Request) {
  try {
    const data = await body(req);
    if (data.action === "refresh") return NextResponse.json(await catalogPage(requiredString(data.id, "id"), "", undefined, true));
    if (data.action === "restore") { await removeSource(requiredString(data.id, "id"), true); return NextResponse.json({ sources: listSources() }); }
    const id = typeof data.id === "string" ? data.id : undefined;
    const old = id ? getSource(id, false) : undefined;
    const input = normalizeInput({ ...old, ...data } as unknown as SourceInput);
    if (old?.builtin && sourceIdentity(old) !== sourceIdentity(input)) throw new SkillSourceError("builtin", "Create a custom source to use a different endpoint");
    const credential = input.clearCredential ? "" : input.credential || (old && sourceIdentity(old) === sourceIdentity(input) ? sourceCredential(old.id) : "") || "";
    const probe: SkillSource = { ...input, id: old && sourceIdentity(old) === sourceIdentity(input) ? old.id : randomUUID(), enabled: true };
    // Disabling does not require a working network. All new/edited enabled sources must validate.
    if (input.enabled || data.action === "test") await fetchCatalog(probe, probe.id === "skills-sh" && !credential ? "react" : "", undefined, credential, true);
    if (data.action === "test") { if (old && sourceIdentity(old) === sourceIdentity(input)) recordSourceStatus(old, "ready", new Date().toISOString()); return NextResponse.json({ success: true }); }
    const source = await saveSource(input, id);
    if (source.enabled) recordSourceStatus(source, "ready", new Date().toISOString());
    return NextResponse.json({ source, sources: listSources() });
  } catch (error) { return apiError(error); }
}
export const PATCH = POST;
export async function DELETE(req: Request) {
  try { const data = await body(req); await removeSource(requiredString(data.id, "id")); return NextResponse.json({ sources: listSources() }); } catch (error) { return apiError(error); }
}
