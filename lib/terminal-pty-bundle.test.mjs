import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");

test("terminal PTY loader survives the server production bundler", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-pty-bundle-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const source = await readFile(new URL("./terminal-pty.ts", import.meta.url), "utf8");
  // Route sources use javascript/auto. An .mjs fixture skips Webpack's
  // CommonJS/createRequire parser and would miss the production failure.
  await writeFile(path.join(root, "entry.js"), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const compiler = webpack({
    mode: "production", target: "node", entry: path.join(root, "entry.js"),
    optimization: { minimize: false },
    output: { path: root, filename: "bundle.cjs", library: { type: "commonjs2" } },
    externals: [/^node:/, "node-pty"],
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close((closeError) => {
      if (error || closeError) reject(error || closeError);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    });
  }));
  const pty = require(path.join(root, "bundle.cjs")).loadTerminalPty();
  assert.equal(typeof pty.spawn, "function");
});
