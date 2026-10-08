import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { annotateManagedSkills } from "@/lib/skill-sources/install";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: annotateManagedSkills(annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }), cwd),
    diagnostics,
    projectResourcesLoaded: true,
  };
}
