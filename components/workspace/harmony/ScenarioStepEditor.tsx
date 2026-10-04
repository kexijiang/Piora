"use client";

import type { HarmonyScenarioStep, HarmonyUiSelector, HarmonyWaitCondition } from "@/lib/harmony/types";
import styles from "../HarmonyPanel.module.css";

type Action = HarmonyScenarioStep["action"];
export const scenarioActionLabels: Record<Action, readonly [string, string]> = {
  capture_screenshot: ["采集截图", "Capture screenshot"],
  tap: ["点击控件", "Tap control"], double_tap: ["双击控件", "Double tap"], long_press: ["长按控件", "Long press"],
  input_text: ["输入文字", "Enter text"], clear_text: ["清空输入", "Clear text"], scroll_find: ["滚动查找", "Scroll to control"],
  swipe: ["滑动", "Swipe"], fling: ["快速滑动", "Fling"], press_key: ["系统按键", "System key"],
  launch_app: ["启动应用", "Launch app"], stop_app: ["停止应用", "Stop app"], clear_app_data: ["清除应用数据", "Clear app data"],
  uninstall_app: ["卸载应用", "Uninstall app"], install_app: ["安装应用", "Install app"],
  wait_for: ["等待控件", "Wait for control"], assert: ["断言控件", "Assert control"], wait_idle: ["等待页面稳定", "Wait for idle"],
  checkpoint: ["保存检查点", "Save checkpoint"], geometry_assert: ["检查屏幕方向", "Check rotation"], voice_input: ["语音识别验证", "Verify voice input"],
};

export function createScenarioStep(action: Action, app?: { bundleName: string; abilityName?: string }): HarmonyScenarioStep {
  const selector = { id: "", match: "exact" as const };
  switch (action) {
    case "capture_screenshot": return { action };
    case "tap": case "double_tap": case "long_press": case "clear_text": return { action, selector };
    case "input_text": return { action, selector, text: "", append: false };
    case "scroll_find": return { action, selector, direction: "down", maxSwipes: 8, tap: false };
    case "swipe": case "fling": return { action, direction: "up", durationMs: 500 };
    case "press_key": return { action, key: "back" };
    case "launch_app": return { action, bundleName: app?.bundleName ?? "", ...(app?.abilityName ? { abilityName: app.abilityName } : {}) };
    case "stop_app": case "clear_app_data": case "uninstall_app": return { action, bundleName: app?.bundleName ?? "" };
    case "install_app": return { action, hapPath: "", replace: false };
    case "wait_for": case "assert": return { action, condition: { selector, exists: true, timeoutMs: 10000 } };
    case "wait_idle": return { action, idleMs: 250, timeoutMs: 5000 };
    case "checkpoint": return { action, name: "" };
    case "geometry_assert": return { action, rotation: 0 };
    case "voice_input": return { action, audioAssetId: "", profileId: "", timeoutMs: 10000 };
  }
}

function SelectorFields({ value, onChange, chinese, disabled }: {
  value: HarmonyUiSelector; onChange: (selector: HarmonyUiSelector) => void; chinese: boolean; disabled: boolean;
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  return <div className={styles.scenarioSelector}>
    {(["id", "text", "type", "hint", "description"] as const).map((key, index) => <label key={key}>
      {(chinese ? ["控件 ID", "控件文字", "控件类型", "占位文字", "无障碍描述"] : ["Control ID", "Control text", "Control type", "Hint text", "Accessible description"])[index]}
      <input value={value[key] ?? ""} maxLength={500} disabled={disabled} onChange={event => {
        const next = { ...value }; if (event.target.value) next[key] = event.target.value; else delete next[key]; onChange(next);
      }} />
    </label>)}
    <label>{copy("匹配方式", "Match mode")}<select value={value.match ?? "exact"} disabled={disabled} onChange={event => onChange({ ...value, match: event.target.value as HarmonyUiSelector["match"] })}>
      <option value="exact">{copy("完全一致", "Exact")}</option><option value="contains">{copy("包含", "Contains")}</option><option value="starts_with">{copy("开头一致", "Starts with")}</option><option value="ends_with">{copy("结尾一致", "Ends with")}</option>
    </select></label>
    <small>{copy("填写至少一项；多项同时匹配。没有唯一控件时运行会失败，不猜坐标。", "Fill at least one field; all supplied fields must match. Ambiguous controls fail without guessed coordinates.")}</small>
    {(value.within || value.before || value.after || value.inWindow || value.index !== undefined) ? <small>{copy("保留模板中的容器、关系、窗口和位置限定。", "Template container, relation, window and index constraints are preserved.")}</small> : null}
  </div>;
}

function ConditionFields({ value, onChange, chinese, disabled }: {
  value: HarmonyWaitCondition; onChange: (condition: HarmonyWaitCondition) => void; chinese: boolean; disabled: boolean;
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  return <>
    <SelectorFields value={value.selector} onChange={selector => onChange({ ...value, selector })} chinese={chinese} disabled={disabled} />
    <label>{copy("期望状态", "Expected state")}<select value={value.exists === false ? "absent" : "present"} disabled={disabled} onChange={event => onChange({ ...value, exists: event.target.value === "present" })}>
      <option value="present">{copy("控件存在", "Present")}</option><option value="absent">{copy("控件不存在", "Absent")}</option>
    </select></label>
    <label>{copy("等待超时（毫秒）", "Timeout (ms)")}<input type="number" min={100} max={60000} value={value.timeoutMs ?? 10000} disabled={disabled} onChange={event => onChange({ ...value, timeoutMs: Number(event.target.value) })} /></label>
  </>;
}

export function ScenarioStepEditor({ steps, onChange, chinese, disabled, app }: {
  steps: HarmonyScenarioStep[]; onChange: (steps: HarmonyScenarioStep[]) => void; chinese: boolean; disabled: boolean;
  app?: { bundleName: string; abilityName?: string };
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const update = (index: number, step: HarmonyScenarioStep) => onChange(steps.map((current, at) => at === index ? step : current));
  const move = (from: number, to: number) => {
    const next = [...steps]; const [step] = next.splice(from, 1); next.splice(to, 0, step); onChange(next);
  };
  return <section className={styles.scenarioEditor} aria-label={copy("场景步骤编辑器", "Scenario step editor")}>
    <div className={styles.scenarioEditorHeading}><strong>{copy(`步骤 ${steps.length}/64`, `Steps ${steps.length}/64`)}</strong>
      <button type="button" disabled={disabled || steps.length >= 64} onClick={() => onChange([...steps, { ...createScenarioStep("assert", app), id: crypto.randomUUID() }])}>{copy("添加步骤", "Add step")}</button>
    </div>
    {!steps.length ? <p>{copy("添加步骤后可预览；编辑和预览不会操作手机。", "Add steps to preview; editing and preview never operate the phone.")}</p> : null}
    <ol className={styles.scenarioStepList}>{steps.map((step, index) => {
      const patch = (fields: Record<string, unknown>) => update(index, { ...step, ...fields } as HarmonyScenarioStep);
      const text = (name: string, value: string, key: string, multiline = false) => <label>{name}{multiline
        ? <textarea value={value} disabled={disabled} maxLength={8192} onChange={event => patch({ [key]: event.target.value })} />
        : <input value={value} disabled={disabled} maxLength={key === "hapPath" ? 4096 : 256} onChange={event => patch({ [key]: event.target.value })} />}</label>;
      const number = (name: string, value: number, key: string, min: number, max: number) => <label>{name}<input type="number" value={value} min={min} max={max} disabled={disabled} onChange={event => patch({ [key]: Number(event.target.value) })} /></label>;
      const choice = (name: string, value: string | number, key: string, options: Array<readonly [string | number, string]>) => <label>{name}<select value={value} disabled={disabled} onChange={event => patch({ [key]: typeof value === "number" ? Number(event.target.value) : event.target.value })}>{options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}</select></label>;
      const toggle = (name: string, checked: boolean, key: string) => <label className={styles.scenarioCheckbox}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => patch({ [key]: event.target.checked })} />{name}</label>;
      return <li key={step.id ?? index} className={styles.scenarioStepCard}>
        <fieldset disabled={disabled}><legend>{copy(`第 ${index + 1} 步`, `Step ${index + 1}`)}</legend>
          <div className={styles.scenarioStepToolbar}><label>{copy("动作", "Action")}<select value={step.action} onChange={event => update(index, { ...createScenarioStep(event.target.value as Action, app), ...(step.id ? { id: step.id } : {}) })}>
            {Object.entries(scenarioActionLabels).map(([action, label]) => <option key={action} value={action}>{label[chinese ? 0 : 1]}</option>)}
          </select></label>
          <button type="button" aria-label={copy(`上移第 ${index + 1} 步`, `Move step ${index + 1} up`)} disabled={disabled || index === 0} onClick={() => move(index, index - 1)}>↑</button>
          <button type="button" aria-label={copy(`下移第 ${index + 1} 步`, `Move step ${index + 1} down`)} disabled={disabled || index === steps.length - 1} onClick={() => move(index, index + 1)}>↓</button>
          <button type="button" aria-label={copy(`删除第 ${index + 1} 步`, `Remove step ${index + 1}`)} onClick={() => onChange(steps.filter((_, at) => at !== index))}>{copy("删除", "Remove")}</button></div>
          {"selector" in step ? <SelectorFields value={step.selector} onChange={selector => patch({ selector })} chinese={chinese} disabled={disabled} /> : null}
          {step.action === "input_text" ? <>{text(copy("输入内容", "Text to enter"), step.text, "text", true)}{toggle(copy("追加到原文字", "Append to existing text"), step.append ?? false, "append")}</> : null}
          {"bundleName" in step ? text(copy("应用包名", "App bundle"), step.bundleName, "bundleName") : null}
          {step.action === "launch_app" ? <label>{copy("启动入口（可选）", "App entry (optional)")}<input value={step.abilityName ?? ""} maxLength={256} onChange={event => {
            const next = { ...step }; if (event.target.value) next.abilityName = event.target.value; else delete next.abilityName; update(index, next);
          }} /></label> : null}
          {step.action === "install_app" ? <>{text(copy("工作区 HAP 完整路径", "Workspace HAP path"), step.hapPath, "hapPath")}{toggle(copy("替换已安装版本", "Replace installed version"), step.replace ?? false, "replace")}</> : null}
          {step.action === "clear_app_data" || step.action === "uninstall_app" ? <p className={styles.scenarioWarning}>{copy("运行会永久更改目标应用；执行前确认设备和包名。", "Running permanently changes this app; confirm the device and bundle before execution.")}</p> : null}
          {step.action === "swipe" || step.action === "fling" || step.action === "scroll_find" ? choice(copy("方向", "Direction"), step.direction ?? "down", "direction", (step.action === "scroll_find" ? ["up", "down"] : ["up", "down", "left", "right"]).map((value, at) => [value, (chinese ? ["向上", "向下", "向左", "向右"] : ["Up", "Down", "Left", "Right"])[at]])) : null}
          {step.action === "swipe" || step.action === "fling" ? number(copy("滑动时长（毫秒）", "Duration (ms)"), step.durationMs ?? 500, "durationMs", 50, 10000) : null}
          {step.action === "scroll_find" ? <>{number(copy("最多滑动次数", "Maximum swipes"), step.maxSwipes ?? 8, "maxSwipes", 1, 30)}{toggle(copy("找到后点击", "Tap after finding"), step.tap ?? false, "tap")}</> : null}
          {step.action === "press_key" ? choice(copy("系统按键", "System key"), step.key, "key", [["back", copy("返回", "Back")], ["home", copy("主页", "Home")], ["recents", copy("最近任务", "Recents")], ["enter", copy("确认", "Enter")]]) : null}
          {step.action === "wait_for" || step.action === "assert" ? <ConditionFields value={step.condition} onChange={condition => patch({ condition })} chinese={chinese} disabled={disabled} /> : null}
          {step.action === "wait_idle" ? <>{number(copy("稳定等待（毫秒）", "Idle interval (ms)"), step.idleMs ?? 250, "idleMs", 50, 10000)}{number(copy("等待超时（毫秒）", "Timeout (ms)"), step.timeoutMs ?? 5000, "timeoutMs", 100, 60000)}</> : null}
          {step.action === "checkpoint" ? text(copy("检查点名称", "Checkpoint name"), step.name, "name") : null}
          {step.action === "capture_screenshot" ? <label>{copy("截图名称（可选）", "Screenshot name (optional)")}<input value={step.name ?? ""} maxLength={120} onChange={event => {
            const next = { ...step }; if (event.target.value) next.name = event.target.value; else delete next.name; update(index, next);
          }} /></label> : null}
          {step.action === "geometry_assert" ? choice(copy("屏幕方向", "Rotation"), step.rotation, "rotation", [0, 90, 180, 270].map(value => [value, `${value}°`])) : null}
          {step.action === "voice_input" ? <>{text(copy("已导入语料", "Imported audio ID"), step.audioAssetId, "audioAssetId")}{text(copy("已校准语音配置", "Calibrated voice profile"), step.profileId, "profileId")}{number(copy("识音超时（毫秒）", "Voice timeout (ms)"), step.timeoutMs ?? 10000, "timeoutMs", 100, 60000)}</> : null}
          {"waitFor" in step || ["tap", "double_tap", "long_press", "clear_text", "input_text", "launch_app", "swipe", "fling", "press_key", "scroll_find"].includes(step.action) ? <details><summary>{copy("动作后等待条件", "Wait after action")}</summary>
            <button type="button" onClick={() => {
              const next = { ...step } as HarmonyScenarioStep & { waitFor?: HarmonyWaitCondition };
              if (next.waitFor) delete next.waitFor; else next.waitFor = { selector: { text: "" }, exists: true, timeoutMs: 10000 }; update(index, next);
            }}>{"waitFor" in step && step.waitFor ? copy("移除等待条件", "Remove wait") : copy("添加等待条件", "Add wait")}</button>
            {"waitFor" in step && step.waitFor ? <ConditionFields value={step.waitFor} onChange={waitFor => patch({ waitFor })} chinese={chinese} disabled={disabled} /> : null}
          </details> : null}
        </fieldset>
      </li>;
    })}</ol>
  </section>;
}
