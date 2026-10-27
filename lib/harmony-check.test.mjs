import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const runtime = await jiti.import("./harmony/check-runtime.ts");
const configModule = await jiti.import("./harmony/check-config.ts");

test("Harmony checker launches the pinned DevEco platform wrapper", () => {
  assert.equal(runtime.DEVECO_CLI_VERSION, "1.3.9");
  assert.equal(execFileSync(process.execPath, [runtime.DEVECO_CLI_PATH, "--version"], {
    encoding: "utf8", windowsHide: true, timeout: 30000,
  }).trim(), "1.3.9");
});

test("ArkTS LSP diagnostics are normalized to clickable one-based locations", () => {
  const root = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
  const file = process.platform === "win32" ? "C:\\workspace\\sample\\entry\\Index.ets" : "/workspace/sample/entry/Index.ets";
  const raw = `${file} => Diagnostic: ${JSON.stringify([{ severity: 1, code: 1001, message: "Type mismatch", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }])}`;
  const [diagnostic] = runtime.parseArktsDiagnostics(raw, root);
  assert.equal(diagnostic.source, "arkts");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.line, 5);
  assert.equal(diagnostic.column, 3);
  assert.equal(diagnostic.code, "1001");
  assert.equal(diagnostic.message, "Type mismatch");
});

test("DevEco CLI nested ArkTS JSON retains the tool's one-based line", () => {
  const root = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
  const file = process.platform === "win32" ? "C:\\workspace\\sample\\entry\\Index.ets" : "/workspace/sample/entry/Index.ets";
  const nested = JSON.stringify({ severity: "Error", code: 2322, message: "Type mismatch", range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } } });
  const [diagnostic] = runtime.parseArktsDiagnostics(`${file} => Diagnostic: ${JSON.stringify([nested])}`, root);
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.line, 5);
  assert.equal(diagnostic.column, 11);
  assert.equal(diagnostic.message, "Type mismatch");
});

test("Code Linter JSON preserves rules, severity, and file counts", () => {
  const root = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
  const result = runtime.parseLintReport({ issues: [{ file: "entry/Index.ets", line: 7, column: 4, severity: "Warning", rule: "@typescript-eslint/no-unused-vars", message: "Unused value" }], summary: { filesChecked: 3 } }, root);
  assert.equal(result.filesChecked, 3);
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.equal(result.diagnostics[0].rule, "@typescript-eslint/no-unused-vars");
  assert.equal(result.diagnostics[0].relativeFile.replace(/\\/g, "/"), "entry/Index.ets");
});

test("project discovery and source fingerprint follow ArkTS edits while ignoring build output", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-harmony-check-"));
  try {
    await mkdir(join(root, "entry", "src", "main", "ets"), { recursive: true });
    await mkdir(join(root, "entry", "build"), { recursive: true });
    await writeFile(join(root, "build-profile.json5"), "{ app: {}, modules: [] }");
    const source = join(root, "entry", "src", "main", "ets", "Index.ets");
    await writeFile(source, "const answer: number = 42;\n");
    await writeFile(join(root, "entry", "build", "Generated.ets"), "broken");
    assert.equal(runtime.findHarmonyProjectRoot(join(root, "entry", "src")), root);
    assert.deepEqual(runtime.collectArktsFiles(root), [source]);
    const before = runtime.sourceFingerprint(root);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(source, "const answer: number = 43;\n");
    assert.notEqual(runtime.sourceFingerprint(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit ArkTS files cannot escape the selected project", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-harmony-check-path-"));
  try {
    await writeFile(join(root, "build-profile.json5"), "{ app: {}, modules: [] }");
    const outside = join(root, "..", `outside-${Date.now()}.ets`);
    await writeFile(outside, "const value = 1;");
    assert.throws(() => runtime.collectArktsFiles(root, [outside]), /inside the project/);
    await rm(outside, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("environment inspection rejects invalid manual installations or unsupported platforms", () => {
  const config = { ...configModule.DEFAULT_HARMONY_CHECK_CONFIG, studioPath: join(tmpdir(), "missing-deveco-studio"), products: {} };
  const environment = runtime.inspectHarmonyCheckEnvironment(config);
  assert.equal(environment.ready, false);
  assert.equal(environment.platformSupported, process.platform === "win32");
  if (process.platform === "win32") assert.match(environment.error, /configured.*invalid/i);
  else assert.equal(environment.error, "ArkTS checking currently supports Windows only");
});

test("configuration clamps time and repair-loop bounds", () => {
  const config = configModule.normalizeHarmonyCheckConfig({ timeoutMs: 999_999, maxAgentIterations: -2, arktsEnabled: false, lintEnabled: true });
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.maxAgentIterations, 1);
  assert.equal(config.arktsEnabled, false);
  assert.equal(config.lintEnabled, true);
});
