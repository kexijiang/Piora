import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const { SessionCatalogIndex, readSessionCatalogEntry } = await createJiti(import.meta.url).import("./session-catalog-index.ts");

const serialize = entries => entries.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
async function removeFixture(root) {
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
test("metadata matches SDK including activity time, title clears, malformed lines and forks", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-catalog-"));
  const folder = join(root, "project"); await mkdir(folder);
  let reads = 0;
  const index = new SessionCatalogIndex(async (...args) => { reads++; return readSessionCatalogEntry(...args); });
  const file = join(folder, "one.jsonl");
  try {
    await writeFile(file, serialize([
      { type: "session", version: 3, id: "one", timestamp: "2026-01-01T00:00:00Z", cwd: root, parentSession: "/parent.jsonl" },
      "invalid incomplete JSON",
      { type: "message", timestamp: "2026-02-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "你好" }, { type: "image", data: "x".repeat(100_000) }, { type: "text", text: "world" }] } },
      { type: "message", timestamp: "2026-03-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 1769999999999 } },
      { type: "message", timestamp: "2026-08-01T00:00:00Z", message: { role: "toolResult", content: [{ type: "text", text: "output" }] } },
      { type: "session_info", name: "named" }, { type: "session_info", name: "  " },
    ]));
    const expected = (await SessionManager.listAll(folder)).map(info => {
      const entry = { ...info }; delete entry.allMessagesText; return entry;
    });
    assert.deepEqual(await index.list(root), expected);
    for (let i = 0; i < 5; i++) assert.deepEqual(await index.list(root), expected);
    assert.equal(reads, 1, "unchanged histories are parsed exactly once across refreshes");
    await appendFile(file, serialize([{ type: "session_info", name: "renamed" }]));
    assert.equal((await index.list(root))[0].name, "renamed"); assert.equal(reads, 2);
    const next = join(folder, "new.jsonl"); await rename(file, next);
    assert.equal((await index.list(root))[0].path, next); assert.equal(reads, 3);
    await rm(next); assert.deepEqual(await index.list(root), []);
  } finally { await removeFixture(root); }
});

test("rewritten sessions, concurrent appends and oversized metadata never reuse stale entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-catalog-")); const folder = join(root, "project"); await mkdir(folder);
  const file = join(folder, "one.jsonl");
  const header = { type: "session", id: "one", timestamp: "2026-01-01T00:00:00Z", cwd: root };
  let reads = 0;
  const index = new SessionCatalogIndex(async (...args) => {
    reads++; const result = await readSessionCatalogEntry(...args);
    if (reads === 1) await appendFile(file, serialize([{ type: "session_info", name: "appended" }]));
    return result;
  });
  try {
    await writeFile(file, serialize([header]));
    await index.list(root); assert.equal((await index.list(root))[0].name, "appended"); assert.equal(reads, 2);
    await writeFile(file, serialize([{ ...header, id: "rewritten" }]));
    assert.equal((await index.list(root))[0].id, "rewritten");
    let oversizedReads = 0;
    const bounded = new SessionCatalogIndex(async (...args) => { oversizedReads++; return readSessionCatalogEntry(...args); }, 1);
    await bounded.list(root); await bounded.list(root); assert.equal(oversizedReads, 2);
  } finally { await removeFixture(root); }
});

test("equal activity times keep SDK discovery order despite different file read speeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-catalog-")); const catalogRoot = join(root, "sessions"); const folder = join(catalogRoot, "project"); await mkdir(folder, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    for (const id of ["a", "b", "c"]) {
      await writeFile(join(folder, `${id}.jsonl`), serialize([{ type: "session", id, timestamp: "2026-01-01T00:00:00Z", cwd: root }]));
      await utimes(join(folder, `${id}.jsonl`), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    }
    const index = new SessionCatalogIndex(async (file, modified) => {
      if (file.endsWith("a.jsonl")) await new Promise(resolve => setTimeout(resolve, 20));
      return readSessionCatalogEntry(file, modified);
    });
    // Compare the SDK's global catalog, which is the Piora sidebar contract;
    // custom-directory listAll has a different filename-only discovery order.
    const expected = (await SessionManager.listAll()).map(entry => entry.id);
    assert.deepEqual((await index.list(catalogRoot)).map(entry => entry.id), expected);
    assert.deepEqual((await index.list(catalogRoot)).map(entry => entry.id), expected);
    await utimes(join(folder, "b.jsonl"), new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    assert.deepEqual((await index.list(catalogRoot)).map(entry => entry.id), (await SessionManager.listAll()).map(entry => entry.id));
    assert.equal((await index.list(catalogRoot))[0].id, "b");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await removeFixture(root);
  }
});

test("a catalog larger than the metadata budget retains useful cache hits without dropping sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-catalog-")); const folder = join(root, "project"); await mkdir(folder);
  try {
    for (let id = 0; id < 12; id++) {
      await writeFile(join(folder, `${id}.jsonl`), serialize([{ type: "session", id: String(id), timestamp: "2026-01-01T00:00:00Z", cwd: root }]));
    }
    let reads = 0;
    const index = new SessionCatalogIndex(async (...args) => { reads++; return readSessionCatalogEntry(...args); }, 2000);
    assert.equal((await index.list(root)).length, 12); assert.equal(reads, 12);
    reads = 0;
    assert.equal((await index.list(root)).length, 12);
    assert.ok(reads > 0 && reads < 12, "bounded scans must reuse admitted entries instead of evicting them all");
  } finally { await removeFixture(root); }
});
