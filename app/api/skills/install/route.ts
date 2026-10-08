import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import { invalidateServicesCache } from "@/lib/rpc-manager";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { allowedCwd, apiError, body as readBody, requiredString } from "@/lib/skill-sources/api";
import { installRemoteSkill } from "@/lib/skill-sources/install";
import { SkillSourceError } from "@/lib/skill-sources/types";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const data = await readBody(req);
    if (data.sourceId !== undefined) {
      if (data.scope !== "global" && data.scope !== "project") throw new SkillSourceError("scope", "Invalid install scope");
      const cwd = await allowedCwd(data.cwd, data.scope === "project");
      const install = await installRemoteSkill({ sourceId: requiredString(data.sourceId, "sourceId"), skillId: requiredString(data.skillId, "skillId"), scope: data.scope, cwd, version: typeof data.version === "string" ? data.version : undefined });
      invalidateServicesCache();
      return NextResponse.json({ success: true, install });
    }
    const { package: pkg, scope, cwd } = data as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });

    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "cwd required for project install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      return NextResponse.json({ error: output.slice(-300) || "Install failed" }, { status: 500 });
    }
    invalidateServicesCache();
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    if (e instanceof SkillSourceError) return apiError(e);
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
