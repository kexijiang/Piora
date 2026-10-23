import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("team settings text fields explain their purpose and preview AI optimization before replacement", async () => {
  const [field, settings] = await Promise.all([
    readFile(new URL("./AITextAreaField.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RoomSettingsDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(field, /AI 优化/);
  assert.match(field, /优化结果预览/);
  assert.match(field, /采用优化结果/);
  assert.match(field, /readPromptOptimizerModel/);
  assert.match(field, /fetch\("\/api\/prompts\/optimize"/);
  assert.match(settings, /help="说明团队要解决什么/);
  assert.match(settings, /label="成员设定（可选）" help="自由定义擅长领域、性格、说话风格或工作方式；留空也能正常交流。"/);
  assert.match(settings, /help="约定文件放哪里/);
});
