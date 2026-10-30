/** Explicit adapters only. This command never chooses credentials or providers on its own. */
import { readFile, writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createEvaluationManifest, summarizeEvaluation, validateEvaluationRun, sha256 } from "../lib/intelligent-ui/evaluation.mjs";

const [command, ...argv] = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Options require explicit values");
  if (options.has(argv[i])) throw new Error(`Duplicate option: ${argv[i]}`);
  options.set(argv[i], argv[i + 1]);
}
function option(name, fallback) { const value = options.get(name) ?? fallback; if (!value) throw new Error(`Required option: ${name}`); return value; }
const directory = resolve(option("--output"));
const suitePath = resolve(option("--suite", "tests/fixtures/intelligent-ui/evaluation-cases.json"));
const suite = JSON.parse(await readFile(suitePath, "utf8"));
const manifestPath = join(directory, "manifest.json"), runsPath = join(directory, "runs.jsonl");
const readRuns = async () => {
  try { return (await readFile(runsPath, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};

if (command === "prepare") {
  const baselinePath = resolve(option("--baseline", "tests/fixtures/intelligent-ui/phase1-tool.json"));
  const baseline = await readFile(baselinePath, "utf8");
  const manifest = createEvaluationManifest(suite, {
    models: option("--models").split(","), policyVersions: option("--policies", "phase1,intent-4").split(","),
    repetitions: Number(option("--repetitions", "3")), split: option("--split", "development"), baselineSha256: sha256(baseline), scope: option("--scope", "isolated-model-generation"),
  });
  // Settings are fixed before executing a single run; empty settings mean provider/SDK defaults, recorded explicitly.
  manifest.modelSettings = options.has("--settings") ? JSON.parse(await readFile(resolve(options.get("--settings")), "utf8")) : {};
  manifest.baselinePath = baselinePath;
  manifest.createdAt = new Date().toISOString();
  manifest.runnerTimeoutMs = Number(option("--timeout-ms", "180000"));
  if (!Number.isSafeInteger(manifest.runnerTimeoutMs) || manifest.runnerTimeoutMs <= 0) throw new Error("Invalid timeout-ms");
  await mkdir(directory, { recursive: true });
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(manifestPath, manifestBytes, { flag: "wx" });
  await writeFile(join(directory, "manifest.sha256"), sha256(manifestBytes) + "\n", { flag: "wx" });
  console.log(`Prepared ${manifest.expectedRunCount} runs; no model requests sent. Frozen manifest: ${manifestPath}`);
} else if (command === "run") {
  const lockPath = join(directory, "run.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
  try {
  const manifestBytes = await readFile(manifestPath, "utf8");
  if ((await readFile(join(directory, "manifest.sha256"), "utf8")).trim() !== sha256(manifestBytes)) throw new Error("Frozen manifest changed");
  const manifest = JSON.parse(manifestBytes);
  if (options.has("--timeout-ms") && Number(options.get("--timeout-ms")) !== manifest.runnerTimeoutMs) throw new Error("Runner timeout differs from frozen manifest");
  if (manifest.baselineSha256 !== sha256(await readFile(manifest.baselinePath, "utf8"))) throw new Error("Baseline artifact changed");
  const runs = await readRuns(); summarizeEvaluation(suite, manifest, runs);
  const adapterPath = resolve(option("--adapter"));
  const adapterSha256 = sha256(await readFile(adapterPath, "utf8"));
  const { runTask, describeEvaluation } = await import(pathToFileURL(adapterPath).href);
  if (typeof runTask !== "function" || typeof describeEvaluation !== "function") throw new Error("Adapter must export runTask and describeEvaluation");
  const description = await describeEvaluation({ policyVersions: manifest.policyVersions, modelSettings: manifest.modelSettings, baselinePath: manifest.baselinePath });
  if (!description || typeof description !== "object" || !Object.keys(description).length) throw new Error("Adapter must describe the effective tool/prompt, settings and dependencies");
  const descriptionSha256 = sha256(description);
  const adapterIdentityPath = join(directory, "adapter.json");
  try {
    const old = JSON.parse(await readFile(adapterIdentityPath, "utf8"));
    if (old.sha256 !== adapterSha256 || old.descriptionSha256 !== descriptionSha256) throw new Error("Adapter or dependencies changed; prepare a new run directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(adapterIdentityPath, JSON.stringify({ path: adapterPath, sha256: adapterSha256, descriptionSha256, description }, null, 2), { flag: "wx" });
  }
  const maxRuns = Number(option("--max-runs", String(manifest.expectedRunCount)));
  if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error("Invalid max-runs");
  const completed = new Set(runs.map(run => JSON.stringify([run.taskId, run.model, run.policyVersion, run.repetition])));
  let count = 0;
  outer: for (const id of manifest.taskIds) for (let repetition = 1; repetition <= manifest.repetitions; repetition++) for (const model of manifest.models) for (const policyVersion of manifest.policyVersions) {
    if (completed.has(JSON.stringify([id, model, policyVersion, repetition]))) continue;
    if (count >= maxRuns) break outer;
    const task = suite.tasks.find(task => task.id === id), started = performance.now();
    const signal = AbortSignal.timeout(manifest.runnerTimeoutMs);
    const result = await runTask({ task, model, policyVersion, repetition, signal, modelSettings: manifest.modelSettings, baselinePath: manifest.baselinePath });
    const run = { ...result, taskId: id, model, policyVersion, repetition, durationMs: performance.now() - started, recordedAt: new Date().toISOString(), adapterSha256 };
    validateEvaluationRun(run, task, manifest);
    await appendFile(runsPath, JSON.stringify(run) + "\n");
    runs.push(run); count++;
    console.log(`${id} ${model} ${policyVersion} ${repetition}: ${run.outcome}`);
  }
  await writeFile(join(directory, "summary.json"), JSON.stringify(summarizeEvaluation(suite, manifest, runs), null, 2) + "\n");
  console.log(`Recorded ${count} runs. Technical and human acceptance remain pending unless supplied and independently verified.`);
  } finally {
    await unlink(lockPath);
  }
} else if (command === "summarize") {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const summary = summarizeEvaluation(suite, manifest, await readRuns());
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Summarized ${summary.groups.reduce((n, group) => n + group.runCount, 0)} runs; complete=${summary.complete}.`);
} else {
  throw new Error("Use prepare, run, or summarize; see scripts/evaluate-intelligent-ui.md");
}
