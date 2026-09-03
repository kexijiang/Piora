import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { analyzeDesignSelection } = await jiti.import("./design-to-harmony/analysis.ts");
const { exportDesignAssets } = await jiti.import("./design-to-harmony/asset-export.ts");
const { buildHarmonyPreview, detectHarmonyBuildProfile, parseHarmonyBuildDiagnostics } = await jiti.import("./design-to-harmony/build-adapter.ts");
const { normalizeFigmaDocumentSummary, normalizeFigmaVariables, parseFigmaSourceUrl } = await jiti.import("./design-to-harmony/figma-adapter.ts");
const { DesignPreviewWorkspace } = await jiti.import("./design-to-harmony/preview-workspace.ts");
const { buildDesignPatchSet } = await jiti.import("./design-to-harmony/patch-builder.ts");
const { analyzeHarmonyProject } = await jiti.import("./design-to-harmony/project-analyzer.ts");
const { calculateDesignIrSyncImpact, calculateDesignSyncImpact } = await jiti.import("./design-to-harmony/source-diff.ts");
const { getDesignRunOperationRegistry, resetDesignRunOperationRegistryForTests } = await jiti.import("./design-to-harmony/run-operations.ts");
const { compareDesignScreenshots } = await jiti.import("./design-to-harmony/visual-diff.ts");

const documentFixture = JSON.parse(fs.readFileSync(new URL("./design-to-harmony/fixtures/figma-multipage.json", import.meta.url), "utf8"));
const rawNodes = JSON.parse(fs.readFileSync(new URL("./design-to-harmony/fixtures/figma-analysis-nodes.json", import.meta.url), "utf8"));
const nodeFixture = structuredClone(rawNodes);
nodeFixture["10:1"].document.children = nodeFixture["10:1"].document.children.filter((node) => node.type !== "WIDGET");
const source = parseFigmaSourceUrl("https://www.figma.com/design/Abcdef123/Piora");
const variables = normalizeFigmaVariables({ meta: { variableCollections: {}, variables: {} } });

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function payloads(ids) {
  return ids.flatMap((id) => nodeFixture[id] ? [{ id, document: nodeFixture[id].document }] : []);
}

async function generatedFixture(t, fixtureName, runSuffix) {
  const projectRoot = path.resolve(new URL(`./design-to-harmony/fixtures/${fixtureName}/`, import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
  const record = {
    schemaVersion: 1,
    id: `imp_${runSuffix}`,
    projectRoot,
    source,
    document: normalizeFigmaDocumentSummary(documentFixture, source, variables),
    importedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const adapter = { async getNodes(_ref, ids) { return payloads(ids); } };
  const { ir, plan } = await analyzeDesignSelection({ record, targetNodeIds: ["10:1"], adapter, project: analyzeHarmonyProject(projectRoot) });
  assert.equal(plan.stats.blockingIssues, 0);
  const dataRoot = tempRoot(t, `piora-${fixtureName}-`);
  const workspace = new DesignPreviewWorkspace(dataRoot);
  const runId = `run_${runSuffix}`;
  const preview = workspace.generate(runId, ir, plan);
  const timestamp = new Date().toISOString();
  const run = { schemaVersion: 1, id: runId, projectRoot, importId: record.id, sourceVersion: ir.sourceVersion, targetNodeIds: ir.targetNodeIds, status: "generated", revision: 1, createdAt: timestamp, updatedAt: timestamp, plan, preview: { id: preview.id, manifestHash: preview.hash, generatorVersion: preview.generatorVersion, artifactCount: preview.artifacts.length, totalBytes: preview.totalBytes, generatedAt: timestamp } };
  return { run, preview, workspace, dataRoot };
}

test("project inventory resolves products, module targets, bundle, and abilities", () => {
  const root = path.resolve("lib/design-to-harmony/fixtures/harmony-flex");
  const inventory = analyzeHarmonyProject(root);
  assert.equal(inventory.selectedModule, "entry");
  assert.equal(inventory.selectedTarget, "default");
  assert.equal(inventory.selectedProduct, "default");
  assert.equal(inventory.bundleName, "dev.piora.design.flex");
  assert.equal(inventory.modules[0].abilityName, "EntryAbility");
});

test("real PNG exports are bounded, cached privately, and remain binary through preview", async (t) => {
  const { run, preview: placeholderPreview, workspace, dataRoot } = await generatedFixture(t, "harmony-flex", "22222222222222222222");
  const png = await sharp({ create: { width: 20, height: 12, channels: 4, background: "#5577ee" } }).png().toBuffer();
  let exportCalls = 0;
  let fetchCalls = 0;
  const adapter = {
    async exportAssets(_ref, requests) { exportCalls += 1; return requests.map((request) => ({ nodeId: request.nodeId, url: `https://s3.amazonaws.com/piora/${request.nodeId}.png` })); },
  };
  const irStore = await jiti.import("./design-to-harmony/analysis-ir-store.ts");
  void irStore;
  const analysisAdapter = { async getNodes(_ref, ids) { return payloads(ids); } };
  const record = { schemaVersion: 1, id: run.importId, projectRoot: run.projectRoot, source, document: normalizeFigmaDocumentSummary(documentFixture, source, variables), importedAt: run.createdAt, updatedAt: run.updatedAt };
  const analyzed = await analyzeDesignSelection({ record, targetNodeIds: ["10:1"], adapter: analysisAdapter, project: analyzeHarmonyProject(run.projectRoot) });
  const fetchImpl = async () => { fetchCalls += 1; return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.byteLength) } }); };
  const first = await exportDesignAssets({ adapter, source, sourceVersion: analyzed.ir.sourceVersion, ir: analyzed.ir, plan: analyzed.plan, dataRoot, fetchImpl });
  const second = await exportDesignAssets({ adapter, source, sourceVersion: analyzed.ir.sourceVersion, ir: analyzed.ir, plan: analyzed.plan, dataRoot, fetchImpl });
  assert.equal(first.assets.length, 1);
  assert.equal(first.fallbackReasons.size, 0);
  assert.equal(exportCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(second.cacheHits, 1);
  const exportedPreview = workspace.generate(run.id, analyzed.ir, analyzed.plan, first.assets, first.fallbackReasons);
  const media = exportedPreview.artifacts.find((artifact) => artifact.kind === "media");
  assert.equal(media.mediaType, "image/png");
  assert.equal(exportedPreview.assetPlan[0].strategy, "source_render_png");
  const file = workspace.readFile(run.id, exportedPreview.id, media.relativePath);
  assert.equal(file.encoding, "base64");
  assert.deepEqual(Buffer.from(file.content, "base64"), png);
  const runWithPreview = { ...run, plan: analyzed.plan, preview: { id: exportedPreview.id, manifestHash: exportedPreview.hash, generatorVersion: exportedPreview.generatorVersion, artifactCount: exportedPreview.artifacts.length, totalBytes: exportedPreview.totalBytes, generatedAt: run.updatedAt } };
  const patch = buildDesignPatchSet({ run: runWithPreview, preview: exportedPreview, workspace });
  const mediaPatch = patch.files.find((item) => item.kind === "media");
  assert.equal(mediaPatch.binary, true);
  assert.match(mediaPatch.patch, /^Binary files /);
  assert.notEqual(exportedPreview.id, placeholderPreview.id);
  const cacheContents = fs.readdirSync(path.join(dataRoot, "asset-cache")).map((name) => fs.readFileSync(path.join(dataRoot, "asset-cache", name)));
  assert.equal(cacheContents.some((data) => data.includes(Buffer.from("https://"))), false, "temporary source URLs must not be persisted");
});

test("build diagnostics map generated source paths back to design nodes", () => {
  const preview = { artifacts: [{ relativePath: "entry/src/main/ets/generated/design/SignIn.ets", sourceNodeIds: ["10:1", "11:1"] }] };
  for (const [shadowRoot, sourcePath] of [
    ["C:/shadow", "C:/shadow/entry/src/main/ets/generated/design/SignIn.ets"],
    ["/tmp/shadow", "/tmp/shadow/entry/src/main/ets/generated/design/SignIn.ets"],
  ]) {
    const diagnostics = parseHarmonyBuildDiagnostics(`ERROR: ArkTS:ERROR File: ${sourcePath}:17:9 invalid call`, shadowRoot, preview);
    assert.equal(diagnostics[0].relativePath, "entry/src/main/ets/generated/design/SignIn.ets");
    assert.deepEqual(diagnostics[0].sourceNodeIds, ["10:1", "11:1"]);
    assert.equal(diagnostics[0].line, 17);
  }
});

for (const [fixture, suffix] of [["harmony-flex", "33333333333333333333"], ["harmony-absolute", "44444444444444444444"]]) {
  test(`generated ArkUI compiles in the ${fixture} Harmony fixture when DevEco is available`, async (t) => {
    const generated = await generatedFixture(t, fixture, suffix);
    try { detectHarmonyBuildProfile(generated.run.projectRoot); } catch (error) {
      if (error?.code === "BUILD_TOOL_NOT_FOUND") return t.skip("DevEco Studio is not installed on this test host");
      throw error;
    }
    const result = await buildHarmonyPreview({ ...generated, mode: "preview", timeoutMs: 180_000 });
    assert.equal(result.status, "passed", result.logTail);
    assert.equal(result.exitCode, 0);
    assert.ok(result.hapPath && fs.statSync(result.hapPath).size > 0);
  });
}

test("visual comparison produces bounded regions linked to UI and design nodes", async (t) => {
  const reference = await sharp({ create: { width: 120, height: 160, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const actual = await sharp({ create: { width: 120, height: 160, channels: 4, background: "#ffffff" } }).composite([{ input: Buffer.from('<svg width="120" height="160"><rect x="20" y="30" width="30" height="40" fill="#ff0000"/></svg>') }]).png().toBuffer();
  const outputPath = path.join(tempRoot(t, "piora-visual-"), "diff.png");
  const result = await compareDesignScreenshots({ reference, actual, outputPath, nodes: [{ ref: "node-1", bounds: { left: 15, top: 25, right: 60, bottom: 80 } }], sourceNodeIds: ["10:1"], allowedChangedRatio: 0.001 });
  assert.equal(result.status, "different");
  assert.ok(result.changedRatio > 0);
  assert.ok(result.regions.some((region) => region.uiNodeRefs.includes("node-1") && region.sourceNodeIds.includes("10:1")));
  assert.ok(fs.statSync(outputPath).size > 0);
});

test("visual comparison crops bounded system bars and emits aligned overlay images", async (t) => {
  const reference = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#336699" } }).png().toBuffer();
  const actual = await sharp({ create: { width: 100, height: 120, channels: 4, background: "#000000" } })
    .composite([{ input: Buffer.from('<svg width="100" height="100"><rect width="100" height="100" fill="#336699"/></svg>'), top: 10, left: 0 }])
    .png()
    .toBuffer();
  const root = tempRoot(t, "piora-visual-aligned-");
  const result = await compareDesignScreenshots({
    reference,
    actual,
    outputPath: path.join(root, "diff.png"),
    alignedReferencePath: path.join(root, "reference.png"),
    alignedActualPath: path.join(root, "actual.png"),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.changedPixels, 0);
  assert.ok(fs.statSync(result.referencePath).size > 0);
  assert.ok(fs.statSync(result.actualPath).size > 0);
});

test("source-version impact keeps unchanged targets out of minimal regeneration", () => {
  const current = normalizeFigmaDocumentSummary(documentFixture, source, variables);
  const previous = structuredClone(current);
  previous.version.id = "previous";
  const unchanged = calculateDesignSyncImpact({ previous, current, targetNodeIds: ["10:1"] });
  assert.equal(unchanged.reason, "unchanged");
  assert.deepEqual(unchanged.affectedSourceNodeIds, []);
  previous.pages[0].children[0].name = "Changed frame";
  const changed = calculateDesignSyncImpact({ previous, current, targetNodeIds: [current.pages[0].children[0].id] });
  assert.equal(changed.reason, "source_version_changed");
  assert.deepEqual(changed.affectedSourceNodeIds, [current.pages[0].children[0].id]);
});

test("full IR impact catches deep visual changes that the import summary cannot represent", async () => {
  const projectRoot = path.resolve("lib/design-to-harmony/fixtures/harmony-flex");
  const document = normalizeFigmaDocumentSummary(documentFixture, source, variables);
  const record = { schemaVersion: 1, id: "imp_previous", projectRoot, source, document, importedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  const adapter = { async getNodes(_ref, ids) { return payloads(ids); } };
  const analyzed = await analyzeDesignSelection({ record, targetNodeIds: ["10:1"], adapter, project: analyzeHarmonyProject(projectRoot) });
  const current = structuredClone(analyzed.ir);
  current.roots.find((node) => node.id === "10:1").children.find((node) => node.id === "11:1").text.characters = "A deeply changed label";
  const impact = calculateDesignIrSyncImpact({
    previous: analyzed.ir,
    current,
    previousDocument: document,
    currentDocument: document,
    targetNodeIds: ["10:1"],
    plan: analyzed.plan,
    previousImportId: record.id,
  });
  assert.equal(impact.reason, "source_version_changed");
  assert.ok(impact.changedNodeIds.includes("11:1"));
  assert.deepEqual(impact.affectedSourceNodeIds, ["10:1"]);
  assert.deepEqual(impact.affectedRelativePaths, analyzed.plan.files.map((file) => file.relativePath));
});

test("long-running design operations publish progress and cancel through one abort signal", () => {
  resetDesignRunOperationRegistryForTests();
  const registry = getDesignRunOperationRegistry();
  const events = [];
  const dispose = registry.subscribe("run_55555555555555555555", (event) => events.push(event));
  const controller = registry.start("run_55555555555555555555", "validate");
  registry.progress("run_55555555555555555555", "build", "Compiling", 0.5);
  assert.equal(registry.cancel("run_55555555555555555555"), true);
  assert.equal(controller.signal.aborted, true);
  registry.finish("run_55555555555555555555", "cancelled", "build", "Cancelled");
  dispose();
  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "cancelling", "cancelled"]);
  assert.equal(registry.get("run_55555555555555555555"), undefined);

  const parent = new AbortController();
  const completed = registry.start("run_66666666666666666666", "generate", parent.signal);
  registry.finish("run_66666666666666666666", "completed", "generate", "Complete");
  parent.abort();
  assert.equal(completed.signal.aborted, false, "a completed operation must detach its parent abort listener");
});

test("validation, cancellation, SSE, mappings, project inventory, and visual routes are project-scoped", () => {
  const routes = [
    "../app/api/design-to-harmony/projects/route.ts",
    "../app/api/design-to-harmony/runs/[id]/validate/route.ts",
    "../app/api/design-to-harmony/runs/[id]/cancel/route.ts",
    "../app/api/design-to-harmony/runs/[id]/events/route.ts",
    "../app/api/design-to-harmony/runs/[id]/mappings/route.ts",
    "../app/api/design-to-harmony/runs/[id]/visual/route.ts",
  ].map((value) => fs.readFileSync(new URL(value, import.meta.url), "utf8"));
  for (const route of routes) assert.match(route, /validateDesignProjectRoot/);
  for (const route of routes.slice(1)) assert.match(route, /validateDesignRunId/);
  assert.match(routes[1], /getDesignRunOperationRegistry/);
  assert.match(routes[2], /\.cancel\(id\)/);
  assert.match(routes[3], /text\/event-stream/);
  assert.match(routes[3], /revision/);
  assert.match(routes[5], /"validations", run\.id/);
  assert.match(routes[5], /realpathSync/);
});
