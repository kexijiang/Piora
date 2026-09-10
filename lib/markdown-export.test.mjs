import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createJiti } from "jiti";
const { exportMarkdown } = await createJiti(import.meta.url).import("./markdown-export.ts");
test("plain Markdown exports unchanged without any image requests", async () => {
  const result = await exportMarkdown("title", "# 原文\n", () => { throw new Error("unexpected request"); });
  assert.equal(result.filename, "title.md"); assert.equal(await result.blob.text(), "# 原文\n");
});
test("Markdown ZIP carries deduplicated images and HTML dimensions with portable relative paths", async () => {
  const requests = [];
  const value = '![demo](/api/companion/library/image?id=abc&v=1)\n<img src="/api/companion/library/image?id=abc&amp;v=2" width="320">\n![remote](https://example.com/image.png)';
  const result = await exportMarkdown("my:doc", value, async url => { requests.push(url); return new Response(new Uint8Array([1,2,3]), {headers:{"content-type":"image/png"}}); });
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  assert.equal(result.filename,"my_doc.zip"); assert.deepEqual(requests,["/api/companion/library/image?id=abc"]);
  const markdown = await zip.file("my_doc.md").async("string");
  assert.equal(markdown,'![demo](images/image-1.png)\n<img src="images/image-1.png" width="320">\n![remote](https://example.com/image.png)');
  assert.deepEqual(await zip.file("images/image-1.png").async("uint8array"),new Uint8Array([1,2,3]));
});
test("missing or non-image attachment fails instead of exporting a broken document", async () => {
  await assert.rejects(exportMarkdown("title", "![](/api/companion/library/image?id=missing)",async()=>new Response("missing",{status:404})),/图片读取失败/);
  await assert.rejects(exportMarkdown("title", "![](/api/companion/library/image?id=wrong)",async()=>new Response("html",{headers:{"content-type":"text/html"}})),/格式或大小/);
});
