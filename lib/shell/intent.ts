import type { ShellInputMode } from "./types";

export function classifyShellInput(text: string, commands: readonly string[], mode: ShellInputMode = "auto"): "command" | "agent" | "ambiguous" {
  if (mode !== "auto") return mode;
  const value = text.trim();
  if (!value) return "ambiguous";
  if (/^(?:请|帮我|帮忙|如何|怎么|为什么|查找|查一下|上次|之前|启动这个|安装|检查|解释|修复|please\b|help (?:me|with)\b|how\b|why\b|find the\b|show me\b|explain\b|fix\b)/i.test(value)) return "agent";
  const first = value.match(/^(?:&\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/);
  const token = first?.[1] || first?.[2] || first?.[3] || "";
  const known = new Set(commands.map(command => command.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "")));
  if (known.has(token.toLowerCase().replace(/\.(exe|cmd|bat)$/i, ""))) return "command";
  if (/^(?:\.{1,2}[\\/]|[a-z]:[\\/]|\/[^\s]|\$[\w:]+\s*=|[A-Z_][A-Z0-9_]*=)/i.test(value)) return "command";
  if (/[\u3400-\u9fff]/u.test(token) || /[?？]$/.test(value)) return "agent";
  return "ambiguous";
}
export const SHELL_BUILTINS = ["cd", "pwd", "ls", "dir", "echo", "cat", "type", "clear", "cls", "exit", "history", "alias", "export", "set", "source", "true", "false", "printf", "Get-ChildItem", "Get-Content", "Get-Location", "Set-Location", "Get-Command", "Get-Process", "Get-Service", "Write-Output", "Write-Host", "Select-Object", "Where-Object", "Get-History", "Get-Alias", "Test-Path", "Get-Item", "Get-Help"];
