import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import type { SkillInstallScope } from "@/lib/api-types";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { allowedCwd, apiError, body as readBody, requiredString } from "@/lib/skill-sources/api";
import { findManagedInstall, installRemoteSkill } from "@/lib/skill-sources/install";
import { invalidateServicesCache } from "@/lib/rpc-manager";
import { SkillSourceError } from "@/lib/skill-sources/types";
import { getRuntimeHomeDirectory } from "@/lib/runtime-home";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const data = await readBody(req);
    if (data.installId || (typeof data.package === "string" && data.package.startsWith("piora:"))) {
      if (data.scope !== "global" && data.scope !== "project") throw new SkillSourceError("scope", "Invalid install scope");
      const cwd = await allowedCwd(data.cwd, data.scope === "project");
      const id = requiredString(data.installId || String(data.package).slice(6), "installId");
      const record = findManagedInstall(id, data.scope, cwd);
      const install = await installRemoteSkill({ sourceId: record.sourceId, skillId: record.skillId, scope: data.scope, cwd, updateId: id });
      invalidateServicesCache();
      return NextResponse.json({ success: true, install });
    }
    const body = data as {
      cwd?: unknown;
      package?: unknown;
      scope?: unknown;
    };
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : body.scope === "global" ? getRuntimeHomeDirectory() : "";
    const pkg = typeof body.package === "string" ? body.package : "";
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as SkillInstallScope
      : undefined;
    if (!cwd || !pkg || !scope) {
      return NextResponse.json({ error: "cwd, package, and scope are required" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (body.cwd && !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    if (!skill?.install) {
      return NextResponse.json({ error: "Installed skill not found" }, { status: 404 });
    }
    if (!skill.install.canCheckForUpdates) {
      return NextResponse.json({ error: "This skill cannot be updated automatically" }, { status: 400 });
    }

    const { stdout, stderr } = await runNpx(buildSkillUpdateArgs(skill.install), {
      timeout: 60_000,
      cwd: scope === "project" ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const refreshed = await loadSkillsWithInstallInfo(cwd);
    const updatedSkill = refreshed.skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    return NextResponse.json({
      success: true,
      skill: updatedSkill,
      output: `${stdout}${stderr}`.slice(-500),
    });
  } catch (error: unknown) {
    if (error instanceof SkillSourceError) return apiError(error);
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
    return NextResponse.json(
      { error: output || detail.message || String(error) },
      { status: 500 },
    );
  }
}
