import assert from "node:assert/strict";
import test from "node:test";
import { filterSettingsSearchItems, resolveSettingsPage, SETTINGS_GROUPS, SETTINGS_SEARCH_ITEMS } from "./settings-search.ts";

const zh = new Map([
  ["settings.autoLaunch", "开机时自动启动 Piora"],
  ["settings.autoLaunchDescription", "登录这台电脑后自动启动 Piora。"],
  ["speech.packTitle", "语音识别包"],
  ["speech.packDescription", "包含多语言模型。"],
  ["common.plugins", "插件"],
  ["settings.pluginsDescription", "安装与管理包插件"],
  ["common.language", "语言"],
  ["networkProxy.title", "网络代理"],
  ["modelRetry.title", "模型请求超时与重试"],
  ["modelCompaction.title", "上下文自动压缩"],
  ["archive.title", "已归档会话"],
]);
const translate = (key) => zh.get(key) ?? key;

test("settings search catalog has stable unique ids and searchable leaf settings", () => {
  assert.equal(new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).size, SETTINGS_SEARCH_ITEMS.length);
  assert.equal(filterSettingsSearchItems("开机", translate, { hasProject: true, hasDesktop: true })[0]?.id, "general.autoLaunch");
  assert.ok(filterSettingsSearchItems("onnx", translate, { hasProject: true }).some((item) => item.section === "speech"));
  assert.ok(filterSettingsSearchItems("语音", translate).some((item) => item.id === "shortcuts.voice"));
  assert.equal(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "general.browser"), false);
});

test("browser search excludes controls only available in the desktop app", () => {
  assert.equal(filterSettingsSearchItems("开机", translate, { hasDesktop: false }).some((item) => item.id === "general.autoLaunch"), false);
  for (const item of SETTINGS_SEARCH_ITEMS.filter((item) => item.requiresDesktop)) {
    assert.equal(filterSettingsSearchItems(item.labelKey, (key) => key, { hasDesktop: false, limit: 100 }).some((result) => result.id === item.id), false);
  }
});

test("project-only settings are omitted until a project is available", () => {
  assert.equal(filterSettingsSearchItems("插件", translate, { hasProject: false }).some((item) => item.id === "plugins"), false);
  assert.equal(filterSettingsSearchItems("插件", translate, { hasProject: true })[0]?.id, "plugins");
});

test("empty unified search shows only section shortcuts", () => {
  const results = filterSettingsSearchItems("", translate, { hasProject: true, limit: 20 });
  assert.ok(results.length > 0);
  assert.ok(results.every((item) => item.id === item.section));
});

test("five settings groups expose every page directly", () => {
  assert.deepEqual(SETTINGS_GROUPS.map((group) => group.pages.length), [5, 5, 6, 3, 5]);
  assert.equal(resolveSettingsPage("plugins").key, "plugins");
  assert.equal(resolveSettingsPage("tools").key, "tools");
  assert.equal(resolveSettingsPage("trash").key, "trash");
  assert.equal(resolveSettingsPage("modelRuntime").key, "modelRuntime");
  assert.equal(SETTINGS_GROUPS.flatMap((group) => group.pages).some((page) => page.key === "language"), false);
});

test("search targets follow settings moved into purpose-specific pages", () => {
  const find = (query) => filterSettingsSearchItems(query, translate, { hasProject: true, hasDesktop: true, limit: 100 });
  assert.equal(find("语言").find((item) => item.id === "language")?.section, "appearance");
  assert.equal(find("代理").find((item) => item.id === "general.proxy")?.section, "network");
  assert.equal(find("模型请求超时").find((item) => item.id === "general.modelRetry")?.section, "modelRuntime");
  assert.equal(find("压缩阈值").find((item) => item.id === "models.compaction")?.section, "modelRuntime");
  assert.equal(find("插件").find((item) => item.id === "plugins")?.section, "plugins");
  assert.equal(find("归档").find((item) => item.id === "archived")?.section, "archived");
});
