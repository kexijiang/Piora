import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");
const {
  RUN_STATUS_PHRASES,
  pickRunStatusPhraseId,
  runStatusMessagesEn,
  runStatusMessagesZh,
  runStatusPhraseKey,
  settleRunElapsedView,
} = await jiti.import("./run-status-phrases.ts");

const FORBIDDEN = ["思考中", "Thinking", "加载中", "处理中", "Piora 思考中", "Loading", "Processing"];

function includesForbidden(text) {
  const folded = text.toLowerCase();
  return FORBIDDEN.some((phrase) => folded.includes(phrase.toLowerCase()));
}

test("run status phrases stay in the branded set with en/zh parity", () => {
  assert.ok(RUN_STATUS_PHRASES.length >= 16 && RUN_STATUS_PHRASES.length <= 20);
  const ids = RUN_STATUS_PHRASES.map((phrase) => phrase.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(RUN_STATUS_PHRASES.map((phrase) => phrase.zh)).size, ids.length);
  assert.equal(new Set(RUN_STATUS_PHRASES.map((phrase) => phrase.en)).size, ids.length);

  for (const phrase of RUN_STATUS_PHRASES) {
    assert.ok(phrase.zh.trim().length > 0, phrase.id);
    assert.ok(phrase.en.trim().length > 0, phrase.id);
    assert.notEqual(phrase.zh, phrase.en, phrase.id);
    assert.equal(includesForbidden(phrase.zh), false, phrase.zh);
    assert.equal(includesForbidden(phrase.en), false, phrase.en);
    assert.equal(runStatusMessagesZh[runStatusPhraseKey(phrase.id)], phrase.zh);
    assert.equal(runStatusMessagesEn[runStatusPhraseKey(phrase.id)], phrase.en);
  }

  assert.deepEqual(Object.keys(runStatusMessagesZh).sort(), Object.keys(runStatusMessagesEn).sort());
  assert.equal(runStatusMessagesZh["runStatus.live"], "{phrase}，用时 {duration}");
  assert.equal(runStatusMessagesEn["runStatus.live"], "{phrase} · {duration}");
  assert.equal(runStatusMessagesZh["runStatus.done"], "已完成，用时 {duration}");
  assert.equal(runStatusMessagesEn["runStatus.done"], "Done in {duration}");
  assert.equal(includesForbidden(runStatusMessagesZh["runStatus.live"]), false);
  assert.equal(includesForbidden(runStatusMessagesEn["runStatus.live"]), false);
  assert.equal(includesForbidden(runStatusMessagesZh["runStatus.done"]), false);
  assert.equal(includesForbidden(runStatusMessagesEn["runStatus.done"]), false);
});

test("locale catalogs carry the same run-status copy", () => {
  for (const key of Object.keys(runStatusMessagesZh)) {
    assert.equal(zhCNLocale.messages[key], runStatusMessagesZh[key], key);
    assert.equal(enLocale.messages[key], runStatusMessagesEn[key], key);
  }
});

test("phrase selection is deterministic and does not repeat the previous turn", () => {
  const first = pickRunStatusPhraseId(null, () => 0);
  assert.equal(first, RUN_STATUS_PHRASES[0].id);

  let previous = null;
  for (let index = 0; index < RUN_STATUS_PHRASES.length * 3; index += 1) {
    const id = pickRunStatusPhraseId(previous, () => 0);
    assert.notEqual(id, previous);
    assert.ok(RUN_STATUS_PHRASES.some((phrase) => phrase.id === id));
    previous = id;
  }

  const lastOfFull = pickRunStatusPhraseId(null, () => 0.999999);
  assert.equal(lastOfFull, RUN_STATUS_PHRASES[RUN_STATUS_PHRASES.length - 1].id);
  const avoidingLast = pickRunStatusPhraseId(lastOfFull, () => 0.999999);
  assert.notEqual(avoidingLast, lastOfFull);
  assert.equal(avoidingLast, RUN_STATUS_PHRASES[RUN_STATUS_PHRASES.length - 2].id);
});

test("a turn keeps one phrase, then the next turn chooses another", () => {
  let roll = 0;
  const random = () => {
    roll += 1;
    return 0;
  };
  const started = settleRunElapsedView({
    running: true,
    runStartedAt: null,
    now: 1_000,
    view: null,
    previousPhraseId: null,
    random,
  });
  assert.equal(started.view?.phraseId, RUN_STATUS_PHRASES[0].id);
  assert.equal(started.view?.startedAt, 1_000);
  assert.equal(started.view?.elapsedMs, null);
  assert.equal(roll, 1);

  const adopted = settleRunElapsedView({
    running: true,
    runStartedAt: 800,
    now: 5_000,
    view: started.view,
    previousPhraseId: started.previousPhraseId,
    random,
  });
  assert.equal(adopted.view?.phraseId, started.view?.phraseId);
  assert.equal(adopted.view?.startedAt, 800);
  assert.equal(roll, 1);

  const held = settleRunElapsedView({
    running: true,
    runStartedAt: null,
    now: 9_000,
    view: adopted.view,
    previousPhraseId: adopted.previousPhraseId,
    random,
  });
  assert.equal(held.view, adopted.view);
  assert.equal(roll, 1);

  const finished = settleRunElapsedView({
    running: false,
    runStartedAt: null,
    now: 66_000,
    view: held.view,
    previousPhraseId: held.previousPhraseId,
    random,
  });
  assert.equal(finished.view?.phraseId, started.view?.phraseId);
  assert.equal(finished.view?.elapsedMs, 65_200);
  assert.equal(roll, 1);

  const stillFinished = settleRunElapsedView({
    running: false,
    runStartedAt: null,
    now: 90_000,
    view: finished.view,
    previousPhraseId: finished.previousPhraseId,
    random,
  });
  assert.equal(stillFinished.view, finished.view);

  const next = settleRunElapsedView({
    running: true,
    runStartedAt: 90_000,
    now: 90_000,
    view: finished.view,
    previousPhraseId: finished.previousPhraseId,
    random,
  });
  assert.notEqual(next.view?.phraseId, finished.view?.phraseId);
  assert.equal(next.view?.elapsedMs, null);
  assert.equal(next.view?.startedAt, 90_000);
  assert.equal(roll, 2);
});
