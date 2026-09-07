import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const subject = await jiti.import("./companion-storage.ts");

test("companion storage migration preserves data and persists the selected directory", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-companion-storage-"));
  try {
    const agentDirectory = join(root, "agent");
    const environment = { PI_CODING_AGENT_DIR: agentDirectory, USERPROFILE: root, HOME: root };
    const initial = subject.getCompanionStorageInfo(environment);
    mkdirSync(initial.directory, { recursive: true });
    writeFileSync(initial.dataFile, "{\"version\":3}\n", "utf8");

    const selected = join(root, "custom-data");
    const migrated = subject.updateCompanionStorageDirectory(selected, environment);
    assert.equal(migrated.directory, selected);
    assert.equal(migrated.customized, true);
    assert.equal(readFileSync(migrated.dataFile, "utf8"), "{\"version\":3}\n");
    assert.equal(JSON.parse(readFileSync(migrated.configFile, "utf8")).directory, selected);

    const restored = subject.updateCompanionStorageDirectory(initial.defaultDirectory, environment);
    assert.equal(restored.directory, initial.defaultDirectory);
    assert.equal(restored.customized, false);
    assert.equal(readFileSync(restored.dataFile, "utf8"), "{\"version\":3}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("companion storage rejects filesystem roots and occupied data targets", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-companion-storage-"));
  try {
    const environment = { PI_CODING_AGENT_DIR: join(root, "agent"), USERPROFILE: root, HOME: root };
    assert.throws(() => subject.updateCompanionStorageDirectory(parse(root).root, environment), /filesystem root/);
    const occupied = join(root, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "companion-runtime.json"), "existing", "utf8");
    assert.throws(() => subject.updateCompanionStorageDirectory(occupied, environment), /already contains/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("companion storage route is local-only and scoped locations can be edited directly", () => {
  const route = readFileSync(new URL("../app/api/companion/storage/route.ts", import.meta.url), "utf8");
  const component = readFileSync(new URL("../components/CompanionStorageSettings.tsx", import.meta.url), "utf8");
  assert.match(route, /isApiRequestAllowed/);
  assert.match(route, /hasJsonContentType/);
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(component, /aria-expanded=\{editing\}/);
  assert.match(component, /scope\?: "library" \| "json"/);
  assert.match(route, /updatePocketStorageDirectory/);
});
