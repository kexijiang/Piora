/** Preserve the server's control state so the workbench can explain a rejected request. */
export class HarmonyRequestError extends Error {
  readonly controlStatus?: "stopping" | "recovering";

  constructor(value: unknown, status: number) {
    const error = value && typeof value === "object" ? value as { code?: unknown; message?: unknown; details?: { state?: unknown } } : undefined;
    super(typeof value === "string" ? value : typeof error?.message === "string" ? error.message : `Request failed (${status})`);
    if (error?.code === "DEVICE_BUSY" && (error.details?.state === "stopping" || error.details?.state === "recovering")) {
      this.controlStatus = error.details.state;
    }
  }

  messageFor(chinese: boolean): string {
    if (this.controlStatus === "stopping") return chinese
      ? "设备正在停止操作，请等待清理完成后重试。"
      : "Device operations are stopping. Wait for cleanup to finish, then try again.";
    if (this.controlStatus === "recovering") return chinese
      ? "上次设备操作的清理尚未确认，请在连接诊断中检查并恢复设备。"
      : "Cleanup from the previous operation is unconfirmed. Check and recover the device in Diagnostics.";
    return this.message;
  }
}
