import assert from "node:assert/strict";
import test from "node:test";
import { runtimeErrorReference, isPageAssetLoadError, formatRuntimeErrorReport } from "./runtime-error-report.ts";

test("client render references distinguish errors while retaining server digests", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'replace')");
  assert.match(runtimeErrorReference(error), /^client-render-[a-f0-9]{8}$/);
  assert.equal(runtimeErrorReference(error), runtimeErrorReference(error));
  assert.notEqual(runtimeErrorReference(error), runtimeErrorReference(new Error("Loading chunk 42 failed")));
  assert.equal(runtimeErrorReference(Object.assign(error, { digest: "server-42" })), "server-42");
});

test("ordinary render errors are not described as asset or cache failures", () => {
  assert.equal(isPageAssetLoadError(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isPageAssetLoadError(new Error("Minified React error #310")), false);
  assert.equal(isPageAssetLoadError(new Error("Loading chunk 42 failed")), true);
  assert.equal(isPageAssetLoadError(new TypeError("Failed to fetch dynamically imported module")), true);
});

test("diagnostics contain the build, environment, stack and bounded error causes", () => {
  const cause = new Error("inner failure");
  const error = new TypeError("render failure", { cause });
  cause.cause = error;
  const report = formatRuntimeErrorReport(error, { version: "0.4.41-beta.32", time: "2026-09-11T00:00:00Z", runtime: "Electron desktop", userAgent: "fixture-agent" });
  assert.ok(report.includes(error.stack));
  assert.ok(report.includes(cause.stack));
  assert.match(report, /Version: 0\.4\.41-beta\.32/);
  assert.match(report, /Runtime: Electron desktop/);
  assert.match(report, /fixture-agent/);
  assert.equal(report.split("Caused by:").length, 2);
});
