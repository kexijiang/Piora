import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = (await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const start = source.indexOf("  const handleSend = useCallback");
const handler = source.slice(start, source.indexOf("  useEffect(() => {\n    submitRef", start));

function harness(onSend) {
  const files = [{ name: "notes.txt", text: "complete attachment", size: 19 }];
  const images = [{ data: "YWJj", mimeType: "image/png", previewUrl: "blob:old" }];
  const env = { useCallback: (fn) => fn, useEffect() {}, submitRef: { current: null }, sendingRef: { current: false },
    value: "full original", attachedFiles: files, attachedImages: images, isStreaming: false, isProcessingImages: false, isAutoModelSelection: false,
    modelChangeCoordinatorRef: { current: { waitForIdle: async () => true } }, onBuiltinCommand: null, shouldMaterializeDirectPrompt: () => false, contextUsage: null,
    draftKeyRef: { current: "session" }, valueRef: { current: "full original" }, attachedImagesRef: { current: images }, attachedFilesRef: { current: files },
    retryOfPromptIdsRef: { current: [] },
    onSend, t: (key) => key, imageToDraftImage: ({ data, mimeType }) => ({ data, mimeType }), draftImagesToAttachedImages: (images) => images.map((image) => ({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` })),
  };
  env.replyDraftRef = { current: { value: env.value, spans: [] } };
  env.resetReplyDraft = (draft) => { env.replyDraftRef.current = draft; env.setValue(draft.value); };
  env.setValue = (value) => { env.valueRef.current = value; };
  env.setAttachedFiles = (value) => { env.attachedFilesRef.current = value; };
  env.setAttachedImages = (value) => { env.attachedImagesRef.current = value; };
  env.setAttachmentError = (value) => { env.error = value; };
  env.clearInput = () => { env.valueRef.current = ""; env.attachedFilesRef.current = []; env.attachedImagesRef.current = []; };
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { env, run: new Function("env", `with(env){${js};return handleSend;}`)(env) };
}

test("actual composer clears on local receipt and late server receipt preserves newer typing", async () => {
  let release, acknowledge;
  const { env, run } = harness(async (_text, _images, _files, durable) => { acknowledge = durable; return await new Promise((resolve) => { release = resolve; }); });
  const sending = run(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.valueRef.current, "full original");
  acknowledge(); assert.equal(env.valueRef.current, "");
  env.valueRef.current = "new draft";
  release(true); await sending;
  assert.equal(env.valueRef.current, "new draft");
});
test("rejected or thrown sends restore cleared originals and fresh attachment previews", async () => {
  for (const throws of [false, true]) {
    const { env, run } = harness(async (_text, _images, _files, durable) => { durable(); if (throws) throw new Error("offline"); return false; });
    await run();
    assert.equal(env.valueRef.current, "full original");
    assert.equal(env.attachedFilesRef.current[0].text, "complete attachment");
    assert.equal(env.attachedImagesRef.current[0].previewUrl, "data:image/png;base64,YWJj");
  }
});
test("failure never replaces another session's composer or subsequent input", async () => {
  for (const switchSession of [false, true]) {
    let finish;
    const { env, run } = harness(async (_text, _images, _files, durable) => { durable(); return await new Promise((resolve) => { finish = resolve; }); });
    const sending = run(); await new Promise((resolve) => setImmediate(resolve));
    if (switchSession) env.draftKeyRef.current = "other";
    else env.valueRef.current = "next message";
    finish(false); await sending;
    assert.equal(env.valueRef.current, switchSession ? "" : "next message");
  }
});
