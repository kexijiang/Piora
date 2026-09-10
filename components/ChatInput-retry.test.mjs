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
    onBuiltinCommand: undefined, contextUsage: null,
    shouldMaterializeDirectPrompt: () => false, t: (key) => key,
    sendingRef: { current: false }, draftKeyRef: { current: "session" },
    retryOfPromptIdsRef: { current: [] },
    modelChangeCoordinatorRef: { current: { waitForIdle: async () => true } },
    imageToDraftImage: ({ data, mimeType }) => ({ data, mimeType }),
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
  env.clearInput = () => {
    env.retryOfPromptIdsRef.current = [];
    env.setValue(""); env.setAttachedImages([]); env.setAttachedFiles([]);
  };
  return { env, send: new Function("env", `with (env) { ${js}; return handleSend; }`)(env) };
}

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
