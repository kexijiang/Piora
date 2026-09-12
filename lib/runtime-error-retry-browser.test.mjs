import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("Retry recovers a rejected lazy import with a new document while normal render errors only reset", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-error-retry-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "entry.tsx"), `
      import React, { lazy, Suspense } from "react";
      import { createRoot } from "react-dom/client";
      import { RuntimeErrorScreen } from ${JSON.stringify(path.join(repo, "components/RuntimeErrorScreen.tsx"))};
      const kind = new URLSearchParams(location.search).get("kind");
      const loads = Number(sessionStorage.getItem("loads") || "0") + 1;
      sessionStorage.setItem("loads", String(loads));
      const error = Object.assign(new Error("Loading chunk app/page failed."), { name: "ChunkLoadError" });
      const Healthy = () => <h1>Recovered page</h1>;
      const LazyPage = lazy(() => loads === 1 ? Promise.reject(error) : Promise.resolve({ default: Healthy }));
      function OrdinaryError() {
        if (!sessionStorage.getItem("resets")) throw new TypeError("Ordinary render failure");
        return <Healthy />;
      }
      class Boundary extends React.Component {
        state = { error: null };
        static getDerivedStateFromError(error) { return { error }; }
        render() {
          return this.state.error ? <RuntimeErrorScreen error={this.state.error} reset={() => {
            sessionStorage.setItem("resets", String(Number(sessionStorage.getItem("resets") || "0") + 1));
            this.setState({ error: null });
          }} /> : this.props.children;
        }
      }
      createRoot(document.getElementById("root")).render(<Boundary><Suspense fallback="Loading">{kind === "chunk" ? <LazyPage /> : <OrdinaryError />}</Suspense></Boundary>);
    `);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] },
      plugins: [new webpack.DefinePlugin({ "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("test") })],
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const kind of ["chunk", "ordinary"]) {
      const page = await browser.newPage({ locale: "en-US" });
      let documents = 0;
      await page.route("http://runtime-error.test/**", route => {
        if (new URL(route.request().url()).pathname === "/bundle.js") return route.fulfill({ body: bundle, contentType: "application/javascript" });
        documents++;
        return route.fulfill({ body: '<main id="root"></main><script src="/bundle.js"></script>', contentType: "text/html" });
      });
      await page.goto(`http://runtime-error.test/?kind=${kind}`);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByRole("heading", { name: "Recovered page" }).waitFor();
      assert.equal(documents, kind === "chunk" ? 2 : 1);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("resets")), kind === "chunk" ? null : "1");
      await page.close();
    }
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-error-retry-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
