import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createDiagramCache, fitDiagram } = await createJiti(import.meta.url).import("./mermaid-preview.ts");

test("Mermaid cache coalesces pending work and reuses completed results", async () => {
  let calls = 0;
  const cache = createDiagramCache(async key => { calls++; return { svg: key, width: 100, height: 200 }; });
  const first = cache.load("light\nA");
  assert.equal(cache.load("light\nA"), first);
  const result = await first;
  assert.equal(cache.peek("light\nA"), result);
  assert.equal(await cache.load("light\nA"), result);
  await cache.load("dark\nA");
  assert.equal(calls, 2, "theme changes must not reuse the other palette");
});

test("Mermaid cache bounds retained entries/characters and retries failures", async () => {
  let fail = true;
  const cache = createDiagramCache(async key => {
    if (key === "bad" && fail) throw Error("parse");
    return { svg: key.repeat(2), width: 1, height: 1 };
  }, 2, 20);
  await assert.rejects(cache.load("bad"), /parse/);
  fail = false;
  await cache.load("bad");
  await cache.load("a");
  await cache.load("b");
  assert.equal(cache.peek("bad"), undefined);
  await cache.load("a");
  await cache.load("c");
  assert.equal(cache.peek("b"), undefined, "touching an entry preserves it");
  await cache.load("huge-diagram");
  assert.equal(cache.peek("huge-diagram"), undefined);
  assert.ok(cache.peek("a"));
});

test("fit uses both viewport dimensions, preserves small diagrams and has no 50% floor", () => {
  assert.equal(fitDiagram({ width: 2000, height: 100 }, { width: 500, height: 400 }), 0.25);
  assert.equal(fitDiagram({ width: 100, height: 4000 }, { width: 500, height: 400 }), 0.1);
  assert.equal(fitDiagram({ width: 60, height: 40 }, { width: 500, height: 400 }), 1);
});
