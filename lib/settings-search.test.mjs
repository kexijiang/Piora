import assert from "node:assert/strict";
import test from "node:test";
import { filterSettingsSearchItems, SETTINGS_SEARCH_ITEMS } from "./settings-search.ts";

const zh = new Map([
  ["settings.autoLaunch", "开机时自动启动 Piora"],
  ["settings.autoLaunchDescription", "登录这台电脑后自动启动 Piora。"],
  ["speech.packTitle", "语音识别包"],
  ["speech.packDescription", "包含多语言模型。"],
  ["common.plugins", "插件"],
  ["settings.pluginsDescription", "安装与管理包插件"],
]);
const translate = (key) => zh.get(key) ?? key;

test("settings search catalog has stable unique ids and searchable leaf settings", () => {
  assert.equal(new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).size, SETTINGS_SEARCH_ITEMS.length);
  assert.equal(filterSettingsSearchItems("开机", translate, { hasProject: true, hasDesktop: true })[0]?.id, "general.autoLaunch");
  assert.ok(filterSettingsSearchItems("onnx", translate, { hasProject: true }).some((item) => item.section === "speech"));
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
