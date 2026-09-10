// Storage/search benchmark. Renderer/native timings are separate acceptance gates.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const { ClipboardDatabase } = require("../desktop/dist/clipboard-database.js");
const { ClipboardStore } = require("../desktop/dist/clipboard-store.js");
const rows = Number(process.argv.find(value => value.startsWith("--rows="))?.split("=")[1] ?? 100000);
assert.ok(Number.isInteger(rows) && rows >= 1000 && rows <= 100000);
const output = path.resolve(".verification/clipboard-performance");
const reuse = process.argv.find(value => value.startsWith("--reuse="))?.slice(8);
const directory = reuse ? path.resolve(reuse) : path.join(output, `run-${randomUUID()}`);
if (reuse) {
  const relative = path.relative(output, directory);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Only an owned benchmark directory may be reused");
  const previous = JSON.parse(await readFile(path.join(directory, "benchmark.json"), "utf8"));
  assert.equal(previous.dataset.rows, rows, "Reused dataset size must match --rows");
}
await mkdir(directory, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const imageHash = createHash("sha256").update(png).digest("hex"), now = Date.now();
const seed = new ClipboardDatabase(directory), seedStart = performance.now();
const sources = ["文档", "浏览器", "编辑器", "资源管理器"];
const records = function* () {
  for (let i = 0; i < rows; i++) {
    const files = i % 33 === 0, image = !files && i % 50 === 0;
    yield { id: `benchmark-${String(i).padStart(6, "0")}`, title: `项目计划 ${i}`, remark: i % 97 === 0 ? "重点：季度交付" : "",
      text: files ? null : `项目计划 ${String(i).padStart(6, "0")}\n${"Release notes: review the content, preserve formatting, and continue the work. 产品方案、会议资料与本周交付内容。\n".repeat(6)}${i % 1009 === 0 ? "needle-rare-marker" : ""}`,
      htmlHash: null, rtfHash: null, imageHash: image ? imageHash : null,
      files: files ? [{ path: path.join(directory, "references", `document-${i}.md`), name: `document-${i}.md`, directory: false }] : [],
      source: { name: sources[i % sources.length], executable: `benchmark-${i % sources.length}.exe` }, createdAt: now - i * 1000, copiedAt: now - i * 1000,
      copies: 1, starred: i % 50 === 0, deletedAt: null, shelfOrder: null };
  }
};
if (!reuse) seed.importRecords(records(), hash => { assert.equal(hash, imageHash); return png; });
assert.ok(seed.status().total >= rows); seed.close();
console.log(JSON.stringify({ phase: "seeded", rows, ms: performance.now() - seedStart, directory }));
const workerStart = performance.now(), store = new ClipboardStore(directory); await store.start();
const report = { machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCPUs: cpus().length, memoryGiB: totalmem() / 1024 ** 3, node: process.version },
  dataset: { rows, directory, description: "~97% UTF-8 text/multi-format records and ~3% unique file-reference sets; shared valid PNG on ~2% of records; six repeated bilingual paragraphs per text record" },
  coldWorkerOpenMs: performance.now() - workerStart, measurements: {}, scope: "Worker/database boundary only. Does not prove popup focus latency, capture-to-render latency, large-image encode or congested-storage gates." };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
const measure = async (name, work, count = 30) => {
  const samples = [];
  for (let i = 0; i < 3; i++) await work(i);
  for (let i = 0; i < count; i++) { const start = performance.now(); await work(i); samples.push(performance.now() - start); }
  const result = { count, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), maxMs: Math.max(...samples) };
  report.measurements[name] = result; console.log(JSON.stringify({ phase: name, ...result }));
};
try {
  let largestPage = 0;
  await measure("warmFirstPage", async () => { const page = await store.query({}); assert.equal(page.items.length, 100); largestPage = Math.max(largestPage, Buffer.byteLength(JSON.stringify(page))); });
  const indexed = ["项目计划", "release", "needle-rare-marker", "000123"];
  await measure("indexedSearch", async i => { await store.query({ text: indexed[i % indexed.length] }); });
  const short = ["重", "重点", "☄", "%_"];
  await measure("shortSearch", async i => { await store.query({ text: short[i % short.length] }); });
  await measure("cancelAbsentShortSearch", async i => {
    const waiting = assert.rejects(store.query({ text: "☄", requestId: i }, "benchmark"), /查询已取消/);
    await store.cancelQuery("benchmark", i); await waiting;
  });
  await measure("capturePersistAndReadSummary", async i => {
    const id = await store.capture({ text: `benchmark-live-${randomUUID()}-${i}` });
    const page = await store.query({}); assert.equal(page.items[0].id, id);
  });
  await measure("status", () => store.status());
  report.largestFirstPageBytes = largestPage;
  report.hostRSSMiB = process.memoryUsage().rss / 1024 ** 2;
  report.searchBudgetsMet = report.measurements.indexedSearch.p95Ms <= 200 && report.measurements.shortSearch.p95Ms <= 500;
  await writeFile(path.join(directory, "benchmark.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, "latest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: "complete", report: path.join(directory, "benchmark.json"), searchBudgetsMet: report.searchBudgetsMet }));
} finally { await store.close(); }
