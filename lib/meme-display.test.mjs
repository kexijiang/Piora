import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { prepareMemeDisplay } = await createJiti(import.meta.url).import("./meme-display.ts");
const image = { path: "C:\\图库\\开心.png", url: "/dsh-memes/pack/happy.png" };
const expected = "![开心](/api/memes/" + "a".repeat(64) + ")";

test("exact catalog paths produce standalone Markdown even without a matching message marker", async () => {
  const calls = [];
  const result = await prepareMemeDisplay({ message: "[描述](old)", hits: [{path:"c:/图库/开心.png",caption:"开心"}] }, [image], async (...args) => { calls.push(args); return expected; });
  assert.deepEqual(calls, [[image.url,"开心"]]);
  assert.equal(result.message, expected);
  assert.equal(result.displayMarkdown, expected);
  assert.equal(result.hits[0].markdown, expected);
});

test("encoded legacy paths resolve only one catalog item", async () => {
  const result = await prepareMemeDisplay({hits:[{path:"/home/library/pack/开心.png",caption:"开心"}]}, [{path:"other",url:"/dsh-memes/pack/%E5%BC%80%E5%BF%83.png"}], async () => expected);
  assert.equal(result.displayMarkdown, expected);
});

test("missing, ambiguous and failed captures never leave a success marker", async () => {
  for (const catalog of [[], [image,image]]) {
    const result = await prepareMemeDisplay({message:"[表情: 开心]",hits:[{path:image.path,caption:"开心",markdown:expected}]}, catalog, () => assert.fail("must not capture ambiguous images"));
    assert.equal(result.displayMarkdown, "");
    assert.equal(result.hits[0].markdown, undefined);
    assert.ok(result.hits[0].error);
    assert.doesNotMatch(result.message, /\[表情:/);
  }
  const result = await prepareMemeDisplay({hits:[{path:image.path,caption:"开心"}]}, [image], async () => {throw Error("private path");});
  assert.equal(result.displayMarkdown, "");
  assert.doesNotMatch(JSON.stringify(result), /private path/);
});

test("partial success keeps successful receipts; no-hit policy responses remain unchanged", async () => {
  const result = await prepareMemeDisplay({hits:[{path:image.path,caption:"开心"},{path:"missing",caption:"missing"}]}, [image], async () => expected);
  assert.equal(result.displayMarkdown, expected);
  assert.ok(result.hits[1].error);
  const off = {message:"send mode off",hits:[]};
  assert.deepEqual(await prepareMemeDisplay(off, [], () => assert.fail()), off);
  assert.equal(off.displayMarkdown, undefined);
});
