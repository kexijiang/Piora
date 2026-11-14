import assert from "node:assert/strict";
import test from "node:test";
import { defaultRunningStatusLabels, normalizeRunningStatusLabels, parseGeneratedRunningStatusLabels, pickRunningStatusLabel } from "./running-status-labels.ts";

test("both default libraries contain 50 distinct valid messages", () => {
  for (const locale of ["zh-CN", "en"]) {
    const labels = defaultRunningStatusLabels(locale);
    assert.equal(labels.length, 50);
    assert.deepEqual(normalizeRunningStatusLabels(labels), labels);
  }
});

test("manual libraries allow additions, edits, deletion and Unicode without duplicate messages", () => {
  assert.deepEqual(normalizeRunningStatusLabels([" 第一条 ", "", "第一条", "手动新增", "🙂".repeat(80)]), ["第一条", "手动新增", "🙂".repeat(80)]);
  assert.throws(() => normalizeRunningStatusLabels(["🙂".repeat(81)]));
  assert.throws(() => normalizeRunningStatusLabels(["two\nlines"]));
  assert.throws(() => normalizeRunningStatusLabels([null]));
  assert.throws(() => normalizeRunningStatusLabels(Array(201).fill("entry")));
  assert.deepEqual(normalizeRunningStatusLabels([]), []);
});

test("model generation accepts only fifty distinct nonempty valid strings", () => {
  const labels = defaultRunningStatusLabels("zh-CN");
  assert.deepEqual(parseGeneratedRunningStatusLabels("```json\n" + JSON.stringify(labels) + "\n```"), labels);
  for (const value of [labels.slice(1), [...labels, "多一条"], Array(50).fill("重复"), [...labels.slice(1), ""], { labels }, null]) {
    assert.throws(() => parseGeneratedRunningStatusLabels(JSON.stringify(value)));
  }
});

test("a random task identity keeps its message across rerenders and refreshes", () => {
  const labels = defaultRunningStatusLabels("zh-CN");
  const results = new Set();
  for (let index = 0; index < 1000; index++) {
    const key = `session:command-${index}`;
    const label = pickRunningStatusLabel(labels, key);
    assert.equal(pickRunningStatusLabel([...labels], key), label);
    assert.ok(labels.includes(label)); results.add(label);
  }
  assert.equal(results.size, 50);
});
