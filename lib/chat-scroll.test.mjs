import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

class ScrollElement {
  constructor(props = {}) { Object.assign(this, { scrollTop: 0, scrollHeight: 2000, clientHeight: 800, parentElement: null, style: {} }, props); }
  querySelector() { return this.spacer ?? null; }
  scrollTo({ top }) { this.scrollTop = top; this.writes = (this.writes ?? 0) + 1; }
}

function loadTypeScriptModule(relativePath) {
  const filename = path.resolve(process.cwd(), relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(output, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(filename),
    Element: ScrollElement,
    getComputedStyle: (element) => element.style,
  }, { filename });
  return loadedModule.exports;
}

const { getContentScrollMetrics, getLiveTailScrollLimit, shouldShowScrollToBottom, scrollLiveTailWheel } = loadTypeScriptModule("lib/chat-scroll.ts");

test("downward wheel input cannot bounce into the blank live tail before correction", () => {
  const container = new ScrollElement({ scrollTop: 350, spacer: { offsetHeight: 800 } });
  const event = { cancelable: true, deltaX: 0, deltaY: 120, deltaMode: 0, target: container, preventDefault() { this.prevented = true; } };
  for (let index = 0; index < 100; index++) assert.equal(scrollLiveTailWheel(container, event, null), true);
  assert.equal(container.scrollTop, 400);
  assert.equal(container.writes, 1, "repeated wheel input at the limit must not trigger scroll correction loops");
  assert.equal(event.prevented, true);
  scrollLiveTailWheel(container, { ...event, deltaY: -3, deltaMode: 1 }, null);
  assert.equal(container.scrollTop, 352);
});

test("nested output panes and zoom retain native wheel handling", () => {
  const container = new ScrollElement({ spacer: { offsetHeight: 800 } });
  const output = new ScrollElement({ scrollHeight: 600, clientHeight: 200, parentElement: container, style: { overflowY: "auto", overscrollBehaviorY: "contain" } });
  const event = { cancelable: true, deltaX: 0, deltaY: 50, deltaMode: 0, target: output, preventDefault() { throw new Error("unexpected interception"); } };
  assert.equal(scrollLiveTailWheel(container, event, null), false);
  output.scrollTop = 400;
  assert.equal(scrollLiveTailWheel(container, event, null), false);
  assert.equal(scrollLiveTailWheel(container, { ...event, target: container, ctrlKey: true }, null), false);
});

test("conversation scroll metrics exclude and clamp the live tail spacer", () => {
  assert.deepEqual({ ...getContentScrollMetrics({
    scrollHeight: 1500,
    scrollTop: 860,
    clientHeight: 600,
    transientTailHeight: 600,
  }) }, {
    scrollHeight: 900,
    scrollTop: 300,
    maxScrollTop: 300,
  });
});

test("conversation scroll metrics remain unchanged without a live tail spacer", () => {
  assert.deepEqual({ ...getContentScrollMetrics({
    scrollHeight: 1500,
    scrollTop: 200,
    clientHeight: 600,
  }) }, {
    scrollHeight: 1500,
    scrollTop: 200,
    maxScrollTop: 900,
  });
});

test("live tail spacer alone does not reveal the scroll-to-bottom control", () => {
  assert.equal(shouldShowScrollToBottom({
    scrollHeight: 1180,
    scrollTop: 0,
    clientHeight: 600,
    transientTailHeight: 600,
    threshold: 96,
  }), false);
});

test("overflowing message content reveals the control when the user is away from the bottom", () => {
  assert.equal(shouldShowScrollToBottom({
    scrollHeight: 1500,
    scrollTop: 200,
    clientHeight: 600,
    transientTailHeight: 600,
    threshold: 96,
  }), true);
});

test("the control stays hidden near the bottom", () => {
  assert.equal(shouldShowScrollToBottom({
    scrollHeight: 1500,
    scrollTop: 830,
    clientHeight: 600,
    transientTailHeight: 600,
    threshold: 96,
  }), false);
});

test("reaching the real content bottom hides the control even with a tail spacer", () => {
  // scrollTop = contentHeight - clientHeight (300) = the scroll-to-bottom
  // target with a 600px live-tail spacer in place. The spacer must not keep
  // the button visible once the user is at the conversation's actual bottom.
  assert.equal(shouldShowScrollToBottom({
    scrollHeight: 1500,
    scrollTop: 300,
    clientHeight: 600,
    transientTailHeight: 600,
    threshold: 96,
  }), false);
});

test("live tail limits native scrolling to real content by default", () => {
  assert.equal(getLiveTailScrollLimit({
    scrollHeight: 2_000,
    scrollTop: 1_200,
    clientHeight: 800,
    transientTailHeight: 800,
  }), 400);
});

test("live tail preserves only the intentional pinned message position", () => {
  assert.equal(getLiveTailScrollLimit({
    scrollHeight: 2_000,
    scrollTop: 1_200,
    clientHeight: 800,
    transientTailHeight: 800,
    pinnedScrollTop: 900,
  }), 900);
});

test("real content growth advances beyond the earlier pinned position", () => {
  assert.equal(getLiveTailScrollLimit({
    scrollHeight: 2_700,
    scrollTop: 1_900,
    clientHeight: 800,
    transientTailHeight: 800,
    pinnedScrollTop: 900,
  }), 1_100);
});
