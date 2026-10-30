/** Stable presentation reasons, separate from protocol error codes and diagnostics. */
const problems = ["file_exists", "file_missing", "parameters_invalid", "target", "changed", "limit", "invalid", "unavailable", "cancelled", "uncertain", "interrupted", "request_unknown", "unsaved"] as const;
export type UiActionProblem = typeof problems[number];
export function readUiActionProblem(value: unknown): UiActionProblem | undefined {
  return typeof value === "string" && (problems as readonly string[]).includes(value) ? value as UiActionProblem : undefined;
}
const messages: Record<"en" | "zh-CN", Record<UiActionProblem, string>> = {
  en: {
    file_exists: "A file already exists at this path. It will not be overwritten. Ask for a save action with a different filename.",
    file_missing: "The parameter file was not found. Put it at the displayed project path, then read it again.",
    parameters_invalid: "The parameter file cannot be used. Check its JSON format, field names and allowed values, then read it again. Your current parameters are unchanged.",
    target: "This file path cannot be used. Check that its folder exists inside the project and that it is a regular file path.",
    changed: "The interface, parameters or target file have changed. Refresh the results and start again with the current values.",
    limit: "The file or action data exceeds the supported size. Use a smaller file or report.",
    invalid: "This action has invalid settings. Ask for an updated interface before trying again.",
    unavailable: "This action is not available for the current task. Check the task's enabled capabilities and permissions.",
    cancelled: "The action has stopped. Start a new action when you are ready.",
    uncertain: "The save result is not confirmed. Check the saved file before starting another save.",
    interrupted: "The action did not finish. Refresh the results before starting a new action.",
    request_unknown: "Could not confirm the result. Refresh to check; the request will not be repeated automatically.",
    unsaved: "Save or resolve your parameter changes first.",
  },
  "zh-CN": {
    file_exists: "这个路径下已有文件。原文件不会被覆盖，请让助手换一个文件名另存。",
    file_missing: "没有找到参数文件。请将文件放到上方显示的项目路径，再重新读取。",
    parameters_invalid: "这份参数文件无法使用。请检查 JSON 格式、字段名和允许的取值，再重新读取。当前参数未改变。",
    target: "无法使用这个文件路径。请确认目录位于项目内且已经存在，并使用普通文件路径。",
    changed: "界面、参数或目标文件已变化。请查询最新结果，再按当前内容重新操作。",
    limit: "文件或操作数据超出支持的大小，请缩小文件或报告后再试。",
    invalid: "这个操作的配置不完整或不符合要求，请让助手更新界面后再试。",
    unavailable: "当前任务不能执行这个操作，请检查任务启用的能力和权限。",
    cancelled: "操作已停止，需要时可以重新发起。",
    uncertain: "暂时无法确认是否保存成功，请先核对保存结果，再发起新的保存。",
    interrupted: "操作未完成，请先查询结果，再决定是否重新操作。",
    request_unknown: "暂时无法确认结果，请查询后再操作。不会自动重复执行。",
    unsaved: "请先保存或处理当前参数的变更。",
  },
};
export const actionProblemText = (problem: UiActionProblem, locale: "en" | "zh-CN") => messages[locale][problem];
