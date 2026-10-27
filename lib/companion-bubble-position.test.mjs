import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("function positionCompanionBubble("), main.indexOf("function stopCompanionWindowMotion("));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("bubble positioning uses planned pet coordinates and resets native size drift", () => {
  let bounds = { x: 0, y: 0, width: 500, height: 328 };
  const context = {
    COMPANION_BUBBLE_WIDTH: 300, COMPANION_BUBBLE_HEIGHT: 128,
    companionWindow: { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 200, width: 156, height: 184 }) },
    companionBubbleWindow: {
      isDestroyed: () => false,
      setBounds: next => { bounds = { ...next }; },
      setPosition: (x, y) => { bounds = { ...bounds, x, y, width: bounds.width + 1, height: bounds.height + 1 }; },
    },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: -1000, y: -200, width: 2000, height: 1000 } }) },
  };
  runInNewContext(compiled + ";globalThis.position = positionCompanionBubble;", context);
  for (let index = 0; index < 500; index++) {
    context.position({ x: 400, y: 500, width: 156, height: 184 });
    assert.deepEqual(bounds, { x: 328, y: 388, width: 300, height: 128 });
  }
  context.position({ x: -990, y: -190, width: 156, height: 184 });
  assert.deepEqual(bounds, { x: -1000, y: -200, width: 300, height: 128 });
  context.position();
  assert.deepEqual(bounds, { x: 28, y: 88, width: 300, height: 128 });
});

test("Windows native bubbles do not grow during repeated drags at fractional DPI", {
  skip: process.platform !== "win32", timeout: 180000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-bubble-dpi-"));
  try {
    const script = path.join(root, "probe.cjs");
    await writeFile(script, `
      const assert = require('node:assert/strict');
      const { app, BrowserWindow, screen } = require('electron');
      const COMPANION_BUBBLE_WIDTH = 300, COMPANION_BUBBLE_HEIGHT = 128;
      let companionBubbleWindow;
      const companionWindow = { isDestroyed: () => false };
      ${compiled}
      app.whenReady().then(async () => {
        companionBubbleWindow = new BrowserWindow({ width: 300, height: 128,
          show: false, frame: false, transparent: true, backgroundMaterial: 'none',
          resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
          backgroundColor: '#00000000' });
        for (let index = 0; index < 120; index++) {
          const pet = { x: 200 + index % 40, y: 250 + index % 30, width: 156, height: 184 };
          positionCompanionBubble(pet);
          await new Promise(resolve => setTimeout(resolve, 2));
          const bounds = companionBubbleWindow.getBounds();
          // A fractional physical pixel can round to one DIP; it must not accumulate.
          assert.ok(Math.abs(bounds.width - 300) <= 1, JSON.stringify(bounds));
          assert.ok(Math.abs(bounds.height - 128) <= 1, JSON.stringify(bounds));
          assert.ok(Math.abs(bounds.x - (pet.x - 72)) <= 1, JSON.stringify(bounds));
          assert.ok(Math.abs(bounds.y - (pet.y - 112)) <= 1, JSON.stringify(bounds));
        }
        companionBubbleWindow.destroy(); app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require("electron"), [script, `--user-data-dir=${path.join(root, String(scale))}`, `--force-device-scale-factor=${scale}`], { env, windowsHide: true });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`DPI ${scale} timed out: ${output}`)); }, 30000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); resolve({ code, output }); });
      });
      assert.equal(result.code, 0, `DPI ${scale}: ${result.output}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
