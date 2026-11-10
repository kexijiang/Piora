import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { readLaboratorySettings, writeLaboratorySettings, getLaboratorySettingsPath } = await jiti.import("./laboratory-settings.ts");
const { GET, PUT } = await jiti.import("../app/api/settings/laboratory/route.ts");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "piora-laboratory-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  });
}
const put = body => PUT(new Request("http://localhost/api/settings/laboratory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

test("laboratory defaults to off and API persists an explicit boolean opt-in", async t => {
  await fixture(t);
  assert.deepEqual(readLaboratorySettings(), { planGoalEnabled: false });
  assert.deepEqual(await (await GET()).json(), { planGoalEnabled: false });
  const enabled = await put({ planGoalEnabled: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { planGoalEnabled: true });
  assert.deepEqual(await (await GET()).json(), { planGoalEnabled: true });
  assert.deepEqual(await (await put({ planGoalEnabled: false })).json(), { planGoalEnabled: false });
});

test("laboratory API rejects coercion, missing fields and unknown settings without changing saved state", async t => {
  await fixture(t); writeLaboratorySettings({ planGoalEnabled: true });
  for (const body of [null, [], {}, { planGoalEnabled: "true" }, { planGoalEnabled: 1 }, { planGoalEnabled: false, unknown: true }]) {
    const response = await put(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
    assert.deepEqual(readLaboratorySettings(), { planGoalEnabled: true });
  }
});

test("corrupt saved settings fail closed and can be repaired through a valid PUT", async t => {
  await fixture(t); writeLaboratorySettings({ planGoalEnabled: true });
  await writeFile(getLaboratorySettingsPath(), '{"planGoalEnabled":"true"}');
  assert.throws(readLaboratorySettings, /invalid/);
  assert.equal((await GET()).status, 500);
  assert.equal((await put({ planGoalEnabled: false })).status, 200);
  assert.deepEqual(readLaboratorySettings(), { planGoalEnabled: false });
});

test("laboratory API bounds JSON request bodies before parsing", async t => {
  await fixture(t);
  assert.equal((await put({ planGoalEnabled: true, oversized: "x".repeat(1_024) })).status, 413);
  assert.deepEqual(readLaboratorySettings(), { planGoalEnabled: false });
});
