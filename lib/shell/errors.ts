export class ShellError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_shell_request") {
    super(message); this.name = "ShellError";
  }
}
/** Runtime instances survive Next hot reload, including their original Error class. */
export function isShellError(value: unknown): value is ShellError {
  if (!(value instanceof Error) || value.name !== "ShellError") return false;
  const error = value as ShellError;
  return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && typeof error.code === "string";
}
export function shellText(value: unknown, name: string, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new ShellError(`Invalid ${name}`);
  }
  return value;
}
export function shellId(value: unknown): string {
  const id = shellText(value, "id", 160);
  if (!/^[\w:.-]+$/.test(id)) throw new ShellError("Invalid id");
  return id;
}
