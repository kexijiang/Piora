import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(".") } });
const { POST } = await jiti.import("../app/api/code-intelligence/route.ts");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "piora-code-intelligence-"));
  const project = path.join(base, "project");
  const outside = path.join(base, "outside.ts");
  fs.mkdirSync(project);
  fs.writeFileSync(outside, "export class Private {}\n");
  globalThis.__piAllowedRootsCache = { roots: new Set([project.replace(/\\/g, "/")]), expiresAt: Date.now() + 60_000 };
  t.after(async () => {
    for (const name of fs.readdirSync(project).filter((entry) => /\.(ets|tsx?|jsx?)$/i.test(entry))) {
      await query({ action: "close", filePath: path.join(project, name), cwd: project });
    }
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { project, outside };
}
async function query(body) {
  const response = await POST(new Request("http://localhost:30141/api/code-intelligence", {
    method: "POST",
    headers: { host: "localhost:30141", origin: "http://localhost:30141", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("ArkTS basic mode follows imports and sees unsaved declarations", async (t) => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, "build-profile.json5"), "{}\n");
  const sourcePath = path.join(project, "Main.ets");
  const targetPath = path.join(project, "Model.ets");
  const source = "import { Model } from './Model'\nconst item: Model = new Model()\n";
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(targetPath, "export class OldName {}\n");
  await query({ action: "sync", filePath: targetPath, cwd: project, content: "export class Model {}\n", version: 100 });
  const result = await query({ action: "definition", filePath: sourcePath, cwd: project, content: source, version: 101, offset: source.lastIndexOf("Model") + 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "arkts-basic");
  assert.equal(result.body.definitions[0].filePath, targetPath);
  assert.equal(result.body.definitions[0].line, 1);
  const completions = await query({ action: "completion", filePath: sourcePath, cwd: project, content: source, version: 102, offset: source.indexOf("Model") + 2 });
  assert.ok(completions.body.suggestions.some((item) => item.label === "Model"));
  const otherPath = path.join(project, "Other.ets");
  fs.writeFileSync(otherPath, "export class Twin {}\n");
  await query({ action: "sync", filePath: otherPath, cwd: project, content: "export class Twin {}\n", version: 103 });
  await query({ action: "sync", filePath: targetPath, cwd: project, content: "export class Model {}\nexport class Twin {}\n", version: 104 });
  const ambiguous = await query({ action: "definition", filePath: sourcePath, cwd: project, content: "const item = Twin\n", version: 105, offset: 14 });
  assert.equal(ambiguous.body.definitions.length, 2);
});

test("TypeScript service resolves cross-file definitions and completions", async (t) => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["*.ts"] }));
  const sourcePath = path.join(project, "Main.ts");
  const targetPath = path.join(project, "Model.ts");
  const source = "import { Model } from './Model'\nconst item = new Model()\n";
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(targetPath, "export class Model {}\n");
  const definition = await query({ action: "definition", filePath: sourcePath, cwd: project, content: source, version: 200, offset: source.lastIndexOf("Model") + 1 });
  assert.equal(definition.status, 200);
  assert.equal(definition.body.mode, "typescript");
  assert.equal(definition.body.definitions[0].filePath, targetPath);
  const completion = await query({ action: "completion", filePath: sourcePath, cwd: project, content: source, version: 201, offset: source.lastIndexOf("Model") + 2 });
  assert.ok(completion.body.suggestions.some((item) => item.label === "Model" && item.detail.includes("Model")));
  const session = [...globalThis.__pioraCodeSessions.values()].find((item) => item.mode === "typescript" && item.root === project);
  assert.ok(session?.tsRuntime);
  await session.tsRuntime.worker.terminate();
  const recovered = await query({ action: "hover", filePath: sourcePath, cwd: project, content: source, version: 202, offset: source.lastIndexOf("Model") + 1 });
  assert.equal(recovered.status, 200);
  assert.match(recovered.body.hover, /Model/);
});

test("code intelligence rejects files outside allowed roots", async (t) => {
  const { project, outside } = fixture(t);
  const result = await query({ action: "definition", filePath: outside, cwd: project, content: "Private", version: 300, offset: 1 });
  assert.equal(result.status, 403);
});

test("JavaScript files work in an inferred project", async (t) => {
  const { project } = fixture(t);
  const sourcePath = path.join(project, "Main.js");
  const targetPath = path.join(project, "Model.js");
  const source = "import { Model } from './Model.js'\nnew Model()\n";
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(targetPath, "export class Model {}\n");
  const result = await query({ action: "definition", filePath: sourcePath, cwd: project, content: source, version: 400, offset: source.lastIndexOf("Model") + 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.definitions[0].filePath, targetPath);
});
