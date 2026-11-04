import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("remembered empty projects reauthorize only through explicit directory validation after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-model-recovery-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const project = join(root, "empty-project");
  const unrelated = join(root, "untrusted");
  mkdirSync(project); mkdirSync(unrelated);
  const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
  const { POST } = await jiti.import("../app/api/cwd/validate/route.ts");
  const { GET } = await jiti.import("../app/api/models/route.ts");
  const { resolveModelRequestCwd } = await jiti.import("./model-runtime-context.ts");
  const validate = path => POST(new Request("http://localhost/api/cwd/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: path }) }));
  try {
    assert.equal((await validate(project)).status, 200);
    assert.equal(await resolveModelRequestCwd(project), resolve(project));
    globalThis.__piAdditionalAllowedRoots = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    const denied = await GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(project)}`));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "access_denied");
    assert.equal((await validate(project)).status, 200);
    assert.equal(await resolveModelRequestCwd(project), resolve(project));
    await assert.rejects(resolveModelRequestCwd(unrelated), error => error.code === "access_denied");
    rmSync(project, { recursive: true });
    assert.equal((await validate(project)).status, 400);
    await assert.rejects(resolveModelRequestCwd(project), error => error.code === "invalid_cwd");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__piAdditionalAllowedRoots = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
