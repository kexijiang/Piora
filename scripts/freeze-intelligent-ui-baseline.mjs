import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";

// Reproduce only the frozen, checked-in source. No ordinary user settings are read/written.
const sourcePath = resolve("tests/fixtures/intelligent-ui/phase1-extension-source.txt");
const outputPath = resolve("tests/fixtures/intelligent-ui/phase1-tool.json");
const source = await readFile(sourcePath, "utf8");
const root = await mkdtemp(join(tmpdir(), "piora-freeze-ui-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
try {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const beta = await jiti.import("../lib/beta-features.ts");
  beta.writeBetaFeatures({ intelligentUi: true }, root);
  const mod = await jiti.evalModule(source, { filename: resolve("extensions/piora-intelligent-ui.ts"), async: true });
  const tools = [];
  mod.default({ registerTool: tool => tools.push(tool), on() {} });
  if (tools.length !== 1) throw new Error("Expected the single phase 1 tool");
  const { name, label, description, promptSnippet, promptGuidelines, parameters } = tools[0];
  const artifact = { version: "phase1", sourceCommit: "d71856aaf96fd8824a79a9dc6e03679b522bd702",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    tool: { name, label, description, promptSnippet, promptGuidelines, parameters } };
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  console.log(outputPath);
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
