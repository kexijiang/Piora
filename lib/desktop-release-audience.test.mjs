import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  RELEASE_AUDIENCE_FILE,
  inferDesktopBuildAudience,
  readOrCreateDesktopReleaseAudience,
} = await jiti.import("../desktop/src/release-audience.ts");

function createLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("only beta builds identify themselves as preview builds", () => {
  assert.equal(inferDesktopBuildAudience("0.4.40-beta.1"), "preview");
  assert.equal(inferDesktopBuildAudience("v0.4.40-beta.12"), "preview");
  assert.equal(inferDesktopBuildAudience("0.4.40"), "stable");
  assert.equal(inferDesktopBuildAudience("0.4.40-alpha.1"), "stable");
});

test("the first installed build permanently selects the local update audience", async (t) => {
  const previewRoot = await mkdtemp(join(tmpdir(), "piora-preview-audience-"));
  const stableRoot = await mkdtemp(join(tmpdir(), "piora-stable-audience-"));
  t.after(() => Promise.all([
    rm(previewRoot, { recursive: true, force: true }),
    rm(stableRoot, { recursive: true, force: true }),
  ]));
  const logger = createLogger();

  assert.equal(readOrCreateDesktopReleaseAudience(previewRoot, "0.4.40-beta.1", logger), "preview");
  assert.equal(readOrCreateDesktopReleaseAudience(previewRoot, "0.4.40", logger), "preview");
  assert.equal(readOrCreateDesktopReleaseAudience(stableRoot, "0.4.40", logger), "stable");
  assert.equal(readOrCreateDesktopReleaseAudience(stableRoot, "0.4.41-beta.1", logger), "stable");

  const previewMarker = JSON.parse(await readFile(join(previewRoot, RELEASE_AUDIENCE_FILE), "utf8"));
  const stableMarker = JSON.parse(await readFile(join(stableRoot, RELEASE_AUDIENCE_FILE), "utf8"));
  assert.equal(previewMarker.audience, "preview");
  assert.equal(previewMarker.sourceVersion, "0.4.40-beta.1");
  assert.equal(stableMarker.audience, "stable");
  assert.equal(stableMarker.sourceVersion, "0.4.40");
});

test("fresh alpha does not enroll and subsequent beta chooses preview", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-alpha-audience-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  readOrCreateDesktopReleaseAudience(root, "1.2.3-alpha.1", createLogger());
  await assert.rejects(readFile(join(root, RELEASE_AUDIENCE_FILE)), { code: "ENOENT" });
  assert.equal(readOrCreateDesktopReleaseAudience(root, "1.2.3-beta.1", createLogger()), "preview");
});
