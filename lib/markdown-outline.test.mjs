import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { markdownOutline } = await createJiti(import.meta.url).import("./markdown-outline.ts");
test("Markdown outline ignores fenced code and supports ATX and setext headings with stable source offsets", () => {
  const text = "# 文档\n\n```md\n# 不是标题\n```\n\n## 第二节\n\n末节\n---\n";
  const outline = markdownOutline(text); assert.deepEqual(outline.map(({ title, level }) => ({ title, level })), [{ title: "文档", level: 1 }, { title: "第二节", level: 2 }, { title: "末节", level: 2 }]);
  assert.equal(outline[1].offset, text.indexOf("## 第二节"));
});
