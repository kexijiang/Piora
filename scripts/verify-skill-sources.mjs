// Opt-in network smoke test. All configuration and installed files live in a temporary home.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "piora-skills-live-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PIORA_HOME = root;
const jiti = createJiti(import.meta.url);
const { getSource } = await jiti.import("../lib/skill-sources/store.ts");
const { fetchCatalog, fetchBundle } = await jiti.import("../lib/skill-sources/adapters.ts");
const { commitSkillBundle } = await jiti.import("../lib/skill-sources/install.ts");
let failed = false;
try {
  for (const id of ["skills-sh", "clawhub", "anthropic-skills", "vercel-skills"]) {
    try {
      const source = getSource(id), page = await fetchCatalog(source, id === "skills-sh" ? "react" : "");
      if (!page.items.length) throw new Error("No live catalog results");
      console.log(`${id}: ${page.items.length} catalog entries`);
      if (id === "clawhub") {
        const bundle = await fetchBundle(source, page.items[0].id);
        console.log(`${id}: downloaded ${bundle.detail.name}, ${bundle.files.size} files`);
      }
      if (id === "vercel-skills") {
        const bundle = await fetchBundle(source, page.items[0].id, page.items[0].version);
        const install = await commitSkillBundle({ sourceId: id, skillId: page.items[0].id, scope: "global" }, bundle);
        await readFile(join(root, "agent", "skills", bundle.detail.name, "SKILL.md"));
        console.log(`${id}: installed ${bundle.detail.name}, ${bundle.files.size} files, ${install.versionHash}`);
      }
    } catch (error) { failed = true; console.error(`${id}: ${error.message}`); }
  }
  console.log("skillhub: not exercised without deployment credentials");
} finally { await rm(root, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
