import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const { createChatCommandCatalog, parseChatInput } = await createJiti(import.meta.url).import("../lib/chat-command-input.ts");

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
    sendDisabled: false, permissionSaving: false, isStreaming: false, isProcessingImages: false, isAutoModelSelection: false, runningSendMode: "steer",
    pendingFileCountRef: { current: 0 },
    onBuiltinCommand: undefined, onQueueInput: undefined, contextUsage: null,
    commandInputOptions: {},
    commandCatalog: createChatCommandCatalog([]), slashCommands: undefined,
    createChatCommandCatalog, parseChatInput,
    setCommandInputOptions: value => { env.commandInputOptions = value; },
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

test("workspace readiness blocks submission without clearing text, attachments or reply ownership", async () => {
  const submissions = [];
  const { env, send } = composer(async (...args) => { submissions.push(args); return true; });
  env.replyDraftRef.current.spans = [{ start: 1, end: 9, id: "reply" }];
  env.sendDisabled = true;
  await send();
  assert.equal(submissions.length, 0);
  assert.equal(env.value, " original\nmessage ");
  assert.equal(env.attachedImages[0].data, "YWJj");
  assert.equal(env.attachedFiles[0].text, "full attachment");
  assert.deepEqual(env.replyDraftRef.current.spans, [{ start: 1, end: 9, id: "reply" }]);
  assert.equal(env.persistenceReleased, undefined);
  env.sendDisabled = false;
  await send();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], " original\nmessage ");
  assert.equal(submissions[0][1][0].data, "YWJj");
  assert.equal(submissions[0][2][0].text, "full attachment");
});

test("a slash path submits as literal text with attachments and its original draft", async () => {
  const submissions = [];
  const { env, send } = composer(async (...args) => { submissions.push(args); return true; });
  const text = "/api/agent/querySkuInfo再新增一个字段，Boolean";
  env.setValue(text);
  env.replyDraftRef.current = { value: text, spans: [] };
  await send();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], text);
  assert.equal(submissions[0][1][0].data, "YWJj");
  assert.equal(submissions[0][2][0].text, "full attachment");
  assert.equal(submissions[0][5].inputMode, "text");
  assert.equal(submissions[0][5].delivery, "next_turn");
});

test("retired approval-saving state cannot block ordinary submissions", async () => {
  let submissions = 0;
  const { env, send } = composer(async () => { submissions++; return true; });
  env.permissionSaving = true;
  await send();
  assert.equal(submissions, 1);
  assert.equal(env.value, "");
});

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

test("durably saved failed sends leave the composer empty and preserve independent new sends", async () => {
  const submissions = [];
  const { env, send } = composer(async (...args) => {
    submissions.push(args);
    args[3]("send-1");
    return false;
  });
  await send();
  assert.equal(env.value, "");
  assert.deepEqual(env.attachedImages, []);
  assert.deepEqual(env.attachedFiles, []);
  assert.deepEqual(env.retryOfPromptIdsRef.current, []);
  assert.equal(env.drafts.has("session"), false);
  env.setValue("new message");
  await send();
  assert.equal(submissions[1][0], "new message");
  assert.equal(submissions[1][4], undefined);
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

const windowSource = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const editStart = windowSource.indexOf("  const handleEditFailedMessage = useCallback");
const editJs = ts.transpileModule(windowSource.slice(editStart, windowSource.indexOf("  const retryInFlight", editStart)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
test("explicit edit restores all failed message materials and retry identity without overwriting a busy composer", async () => {
  const draft = { value: "hello", images: [{ data: "abc", mimeType: "image/png" }], files: [{ name: "note", text: "body" }], replySpans: [], commandInput: { inputMode: "text" }, retryOfPromptIds: ["older"] };
  let restored, focused = false, busy = false;
  const ref = { current: { restoreCommandDraft: value => { if (busy) return false; restored = value; return true; }, focus: () => { focused = true; } } };
  const edit = new Function("useCallback", "chatInputRef", "t", "handleRewindRecovery", `${editJs}; return handleEditFailedMessage;`)(fn => fn, ref, key => key, async () => true);
  await edit({ recoveryDraft: draft, clientPromptId: "failed" });
  assert.deepEqual(restored, { ...draft, retryOfPromptIds: ["failed", "older"] });
  assert.equal(focused, true);
  busy = true; focused = false;
  await assert.rejects(edit({ recoveryDraft: draft }), /composerBusy/);
  assert.equal(focused, false);
});
