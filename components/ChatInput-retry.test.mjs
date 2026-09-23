import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const handleSend = useCallback");
const callback = source.slice(start, source.indexOf("\n  useEffect(", start));
const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

// Execute the production submission callback with controlled component state.
function composer(onSend) {
  const env = {
    useCallback: (fn) => fn,
    value: " original\nmessage ",
    attachedImages: [{ data: "YWJj", mimeType: "image/png", previewUrl: "blob:preview" }],
    attachedFiles: [{ name: "notes.txt", text: "full attachment", size: 15 }],
    isStreaming: false, isProcessingImages: false, isAutoModelSelection: false,
    pendingFileCountRef: { current: 0 },
    onBuiltinCommand: undefined, contextUsage: null,
    shouldMaterializeDirectPrompt: () => false, t: (key) => key,
    sendingRef: { current: false }, draftKeyRef: { current: "session" },
    retryOfPromptIdsRef: { current: [] },
    localVoiceActiveRef: { current: false },
    localVoiceStopRef: { current: async () => {} },
    speechInsertionRef: { current: null },
    modelChangeCoordinatorRef: { current: { waitForIdle: async () => true } },
    imageToDraftImage: ({ data, mimeType }) => ({ data, mimeType }),
    attachedFileToDraftFile: (file) => ({ ...file }),
    setDraft: (key, draft) => { env.drafts.set(key, structuredClone(draft)); },
    getDraft: (key) => env.drafts.get(key) ?? null,
    drafts: new Map(),
    deferDraftPersistence: () => () => { env.persistenceReleased = true; },
    draftImagesToAttachedImages: (images) => images.map((image) => ({ ...image, previewUrl: "blob:restored" })),
    onSend,
    setAttachmentError: (error) => { throw new Error(error); },
  };
  for (const [field, setter, ref] of [
    ["value", "setValue", "valueRef"],
    ["attachedImages", "setAttachedImages", "attachedImagesRef"],
    ["attachedFiles", "setAttachedFiles", "attachedFilesRef"],
  ]) {
    env[ref] = { current: env[field] };
    env[setter] = (value) => { env[field] = value; env[ref].current = value; };
  }
  env.replyDraftRef = { current: { value: env.value, spans: [] } };
  env.resetReplyDraft = (draft) => { env.replyDraftRef.current = draft; env.setValue(draft.value); };
  env.clearInput = () => {
    env.drafts.delete(env.draftKeyRef.current);
    env.retryOfPromptIdsRef.current = [];
    env.setValue(""); env.setAttachedImages([]); env.setAttachedFiles([]);
  };
  return { env, send: new Function("env", `with (env) { ${js}; return handleSend; }`)(env) };
}

test("clears text and attachments immediately while model selection and durable storage are pending", async () => {
  const model = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const response = Promise.withResolvers();
  let submitted = false;
  const { env, send } = composer(async (text, images, files, durable) => {
    submitted = true;
    assert.equal(text, " original\nmessage ");
    assert.equal(images[0].data, "YWJj");
    assert.equal(files[0].text, "full attachment");
    await receipt.promise;
    durable("send-1");
    return response.promise;
  });
  env.modelChangeCoordinatorRef.current.waitForIdle = () => model.promise;
  const sending = send();
  assert.equal(env.value, "", "clears before the first asynchronous wait");
  assert.deepEqual(env.attachedImages, []);
  assert.deepEqual(env.attachedFiles, []);
  assert.equal(submitted, false);
  assert.equal(env.persistenceReleased, undefined);
  model.resolve(true);
  await new Promise(setImmediate);
  assert.equal(submitted, true);
  assert.equal(env.persistenceReleased, undefined, "keeps disk draft until the recovery commit");
  env.setValue("next draft");
  receipt.resolve();
  await new Promise(setImmediate);
  assert.equal(env.persistenceReleased, true);
  assert.equal(env.value, "next draft", "late storage receipt cannot clear newer input");
  response.resolve(true);
  await sending;
  assert.equal(env.value, "next draft");
});

test("failed model selection restores the draft without sending", async () => {
  let submitted = false;
  const { env, send } = composer(() => { submitted = true; });
  env.modelChangeCoordinatorRef.current.waitForIdle = async () => false;
  await send();
  assert.equal(submitted, false);
  assert.equal(env.value, " original\nmessage ");
  assert.equal(env.attachedImages[0].data, "YWJj");
  assert.equal(env.drafts.get("session").files[0].text, "full attachment");
  assert.equal(env.persistenceReleased, true);
});

test("a session switch during model selection restores only the originating saved draft", async () => {
  const model = Promise.withResolvers();
  let submitted = false;
  const { env, send } = composer(() => { submitted = true; });
  env.modelChangeCoordinatorRef.current.waitForIdle = () => model.promise;
  const sending = send();
  env.draftKeyRef.current = "other-session";
  env.setValue("other draft");
  model.resolve(true);
  await sending;
  assert.equal(submitted, false);
  assert.equal(env.value, "other draft");
  assert.equal(env.drafts.get("session").value, " original\nmessage ");
});

test("rejection before any durable receipt restores text, attachments and reply ownership", async () => {
  const { env, send } = composer(async () => false);
  env.replyDraftRef.current.spans = [{ start: 1, end: 9, id: "reply" }];
  await send();
  assert.equal(env.value, " original\nmessage ");
  assert.equal(env.attachedImages[0].data, "YWJj");
  assert.equal(env.attachedFiles[0].text, "full attachment");
  assert.deepEqual(env.replyDraftRef.current.spans, [{ start: 1, end: 9, id: "reply" }]);
  assert.deepEqual(env.retryOfPromptIdsRef.current, []);
  assert.equal(env.persistenceReleased, true);
});

test("sending waits for the final dictation and preserves the draft when decoding fails", async () => {
  const sent = [];
  const { env, send } = composer(async text => { sent.push(text); return true; });
  env.localVoiceActiveRef.current = true;
  env.localVoiceStopRef.current = async () => false;
  await send(); assert.deepEqual(sent, []); assert.equal(env.valueRef.current, " original\nmessage ");
  env.localVoiceStopRef.current = async () => { env.setValue("完整的最后一句。"); return true; };
  await send(); assert.deepEqual(sent, ["完整的最后一句。"]);
});

test("sending an automatically restored failed draft links retries and resets after success", async () => {
  const submissions = [];
  const { env, send } = composer(async (...args) => {
    submissions.push(args);
    args[3](`send-${submissions.length}`);
    return submissions.length >= 3;
  });
  await send();
  assert.equal(env.value, " original\nmessage ");
  assert.equal(env.attachedImages[0].data, "YWJj");
  assert.equal(env.attachedFiles[0].text, "full attachment");
  assert.deepEqual(env.retryOfPromptIdsRef.current, ["send-1"]);
  await send();
  assert.deepEqual(submissions[1][4], ["send-1"]);
  await send();
  assert.deepEqual(submissions[2][4], ["send-2", "send-1"]);
  assert.equal(env.value, "");
  assert.deepEqual(env.retryOfPromptIdsRef.current, []);
  env.setValue(" original\nmessage ");
  await send();
  assert.equal(submissions[3][4], undefined, "a fresh same-text send must be independent");
});

for (const change of ["new input", "different session"]) {
  test(`failed submission does not attach retry identity to ${change}`, async () => {
    const { env, send } = composer(async (_text, _images, _files, durable) => {
      durable("failed-send");
      if (change === "new input") env.setValue("new draft");
      else env.draftKeyRef.current = "other-session";
      return false;
    });
    await send();
    assert.equal(env.value, change === "new input" ? "new draft" : "");
    assert.deepEqual(env.retryOfPromptIdsRef.current, []);
    assert.deepEqual(env.attachedImages, []);
    assert.deepEqual(env.attachedFiles, []);
  });
}
