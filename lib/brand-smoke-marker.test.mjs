import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { validateBrandSmokeMarker } from "../scripts/smoke-test-portable.mjs";

function marker(id) {
  const displayName = "Piora";
  return {
    brand: { id, artifactPrefix: displayName, displayName,
      updateChannels: { stable: "latest", preview: "beta" } },
    windowTitle: `Workspace - ${displayName}`,
    runtimePaths: { userData: resolve("fixture/profile"), sessionData: resolve("fixture/profile"), agentDirectory: resolve("fixture/agent"), partition: "persist:piora" },
  };
}
const paths = { userData: resolve("fixture/profile") };
const agent = resolve("fixture/agent");

test("brand smoke contract accepts matching compiled identity and actual data paths", () => {
  for (const id of ["piora"]) validateBrandSmokeMarker(marker(id), id, paths, agent);
});

test("brand smoke contract rejects cross-brand channels, titles and divergent data roots", () => {
  for (const mutate of [
    m => { m.brand.id = "other"; },
    m => { m.brand.artifactPrefix = "Other"; },
    m => { m.brand.updateChannels.stable = "other-latest"; },
    m => { m.brand.updateChannels.preview = "other-beta"; },
    m => { m.windowTitle = "Other"; },
    m => { m.runtimePaths.userData = resolve("other/profile"); },
    m => { m.runtimePaths.sessionData = resolve("other/profile"); },
    m => { m.runtimePaths.agentDirectory = resolve("other/agent"); },
    m => { m.runtimePaths.partition = "persist:other"; },
  ]) {
    const value = marker("piora");
    mutate(value);
    assert.throws(() => validateBrandSmokeMarker(value, "piora", paths, agent));
  }
});
