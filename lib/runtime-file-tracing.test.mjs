import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const ts = require("typescript");

test("runtime home expansion never adds host files to the standalone dependency trace", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-trace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "user-home");
  await mkdir(join(home, ".cargo", "bin"), { recursive: true });
  await writeFile(join(home, ".cargo", "bin", "unrelated-host.exe"), "host data");
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PIORA_HOME: process.env.PIORA_HOME };
  Object.assign(process.env, { USERPROFILE: home, HOME: home, PIORA_HOME: home });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const entries = ["lib/shell/completions.ts", "lib/native-mcp.ts"];
  const traced = await nodeFileTrace(entries, {
    base: process.cwd(), processCwd: process.cwd(),
    // Trace the actual home-using modules and shared resolver, excluding their
    // unrelated imports. Host files remain eligible so the old glob fails here.
    ignore: path => path.includes("node_modules") || path.endsWith(".ts") && ![...entries, "lib/runtime-home.ts"].includes(path.replaceAll("\\", "/")),
    readFile: async path => {
      try {
        const source = await readFile(path, "utf8");
        return path.endsWith(".ts") ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText : source;
      } catch (error) { if (["ENOENT", "EISDIR"].includes(error.code)) return null; throw error; }
    },
  });
  assert.equal(traced.warnings.size, 0, [...traced.warnings].map(error => error.message).join("\n"));
  assert.ok(![...traced.fileList].some(path => path.includes("unrelated-host.exe")), "the runner's home must not become a recursive asset glob");
  const files = [...traced.fileList].map(path => path.replaceAll("\\", "/"));
  for (const file of entries) assert.ok(files.includes(file), `missing traced entry ${file}`);
  const jiti = createJiti(import.meta.url);
  const { getRuntimeHomeDirectory } = await jiti.import("./runtime-home.ts");
  assert.equal(getRuntimeHomeDirectory(), resolve(home));
});
