import assert from "node:assert/strict";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyCompactionThresholdSettings,
  parseCompactionThresholdSettings,
  readCompactionThresholdSettings,
} from "./compaction-settings.ts";

test("compaction threshold validates the SDK reserve range", () => {
  assert.deepEqual(parseCompactionThresholdSettings({ reserveTokens: 8192 }), { reserveTokens: 8192 });
  for (const value of [-1, 1.5, 131073, "8192", null]) {
    assert.throws(() => parseCompactionThresholdSettings({ reserveTokens: value }), /reserveTokens/);
  }
});

test("saving threshold persists to SDK settings and survives reload", async () => {
  const records = { global: "{}", project: "{}" };
  const storage = {
    withLock(scope, update) {
      const next = update(records[scope]);
      if (next !== undefined) records[scope] = next;
    },
  };
  const editor = SettingsManager.fromStorage(storage);
  assert.equal(readCompactionThresholdSettings(editor).reserveTokens, 16384);
  await applyCompactionThresholdSettings(editor, { reserveTokens: 8192 });
  assert.equal(JSON.parse(records.global).compaction.reserveTokens, 8192);
  const existingSession = SettingsManager.fromStorage(storage);
  assert.equal(existingSession.getCompactionSettings().reserveTokens, 8192);
  assert.equal(existingSession.getCompactionSettings().keepRecentTokens, 20000);
});
