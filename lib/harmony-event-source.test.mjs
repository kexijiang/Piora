import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { subscribeHarmonyEvents } = await createJiti(import.meta.url).import("./harmony/event-source.ts");

test("media observers share one owned metadata stream and do not keep it alive", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const sources = [], messages = [];
  class Source {
    constructor(url) { this.url = url; this.closed = 0; sources.push(this); }
    close() { this.closed++; }
  }
  Object.defineProperty(globalThis, "EventSource", { value: Source, configurable: true, writable: true });
  const cleanup = [];
  t.after(() => { cleanup.forEach(dispose => dispose()); if (original) Object.defineProperty(globalThis, "EventSource", original); else delete globalThis.EventSource; });
  const observe = subscribeHarmonyEvents(event => messages.push(event.data), { connect: false }); cleanup.push(observe);
  assert.equal(sources.length, 0, "a standalone media view retains polling without allocating SSE");
  const first = subscribeHarmonyEvents(() => {}), second = subscribeHarmonyEvents(() => {}); cleanup.push(first, second);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "/api/harmony/events");
  sources[0].onmessage({ data: "first" });
  assert.deepEqual(messages, ["first"]);
  first(); first(); assert.equal(sources[0].closed, 0, "disposal is idempotent and another owner remains");
  second(); assert.equal(sources[0].closed, 1, "observers never retain a persistent connection");
  sources[0].onmessage({ data: "stale" }); assert.deepEqual(messages, ["first"]);
  const reopened = subscribeHarmonyEvents(() => {}); cleanup.push(reopened);
  assert.equal(sources.length, 2);
  sources[1].onmessage({ data: "new" }); assert.deepEqual(messages, ["first", "new"]);
  observe(); sources[1].onmessage({ data: "removed" }); assert.deepEqual(messages, ["first", "new"]);
  reopened(); assert.equal(sources[1].closed, 1);
});

test("a failed metadata connection does not leak an owner or block the next subscription", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  let fail = true, closed = 0;
  class Source { constructor() { if (fail) throw new Error("constructor failed"); } close() { closed++; } }
  Object.defineProperty(globalThis, "EventSource", { value: Source, configurable: true, writable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, "EventSource", original); else delete globalThis.EventSource; });
  assert.throws(() => subscribeHarmonyEvents(() => {}), /constructor failed/);
  fail = false;
  const dispose = subscribeHarmonyEvents(() => {}); dispose();
  assert.equal(closed, 1);
});
