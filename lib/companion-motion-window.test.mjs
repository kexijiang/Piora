import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const motion = await createJiti(import.meta.url).import("../desktop/src/companion-motion.ts");
const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("function stopCompanionWindowMotion("), source.indexOf("function startCompanionWindowDrag("));
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("motion timer stops when placement fails, including a disappearing renderer", () => {
  for (const throwing of [false, true]) {
    let tick, cleared = 0;
    const bubbles = [], errors = [];
    const context = {
      ...motion, companionMotionRevision: 0, companionMotionTimer: undefined,
      companionWindow: { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 100, width: 156, height: 184 }) },
      screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      companionWindowGuard: { place: () => { if (throwing) throw new Error("native failure"); return undefined; } },
      emitCompanionMotionState() {}, positionCompanionBubble: bounds => bubbles.push(bounds),
      setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval: () => { cleared++; },
      logger: { warn: (...args) => errors.push(args) },
    };
    runInNewContext(compiled + ";globalThis.start = startCompanionWindowMotion;", context);
    assert.equal(context.start({ distance: 100, durationMs: 1000 }).ok, true);
    context.emitCompanionMotionState = () => { throw new Error("renderer disappeared"); };
    assert.doesNotThrow(() => tick());
    assert.equal(context.companionMotionTimer, undefined);
    assert.equal(cleared, 1);
    assert.equal(bubbles.length, 0, "failed pet placement cannot move its bubble to the rejected point");
    assert.equal(errors.length, 1);
  }
});
