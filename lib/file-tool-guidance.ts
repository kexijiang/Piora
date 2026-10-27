/** Only advertise tools that are active for this prompt. This is guidance, not a shell gate. */
export function fileToolGuidance(selectedTools: readonly string[]): string {
  const active = new Set(selectedTools);
  const rules: string[] = [];
  if (active.has("read")) rules.push("For inspecting local file contents, use read with path and offset/limit instead of cat, head, tail, sed, or Get-Content. Continue large files with offset/limit; do not repeatedly read only their beginning.");
  if (active.has("ls")) rules.push("For listing a local directory, use ls with path instead of shell ls, dir, or Get-ChildItem.");
  if (active.has("find")) rules.push("For finding local files by name or glob pattern, use find with pattern and path instead of shell find or rg --files.");
  if (active.has("grep")) rules.push("For searching local file contents, use grep with pattern and path instead of shell grep, rg, or Select-String." + (active.has("read") ? " Use read on matched files when you need more context." : ""));
  if (active.has("edit")) rules.push("Use edit for targeted changes to local files instead of shell text replacement scripts.");
  if (active.has("write")) rules.push("Use write for new local files or complete rewrites instead of shell redirection.");
  if (!rules.length) return "";
  rules.push("These preferences apply when a dedicated tool can express the operation. Keep shell tools for builds, tests, Git, processes, pipelines, unsupported formats, and operations that need shell semantics. Follow explicit user tool choices. Do not route remote SSH paths through local file tools. If a dedicated tool is unavailable or cannot handle the task, use an available alternative and retain its real tool identity.");
  return `<piora_file_tools>\n${rules.join("\n")}\n</piora_file_tools>`;
}
