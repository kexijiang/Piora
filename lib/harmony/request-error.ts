/** Preserve the server's control state so the workbench can explain a rejected request. */
export class HarmonyRequestError extends Error {
  readonly code?: string;
  readonly controlStatus?: "stopping" | "recovering";
  readonly signatureRejected: boolean;
  readonly deviceErrorCode?: string;
  private readonly ownedByAnotherInstance: boolean;
  private readonly reason?: string;

  constructor(value: unknown, status: number) {
    const error = value && typeof value === "object" ? value as { code?: unknown; message?: unknown; details?: { state?: unknown; reason?: unknown; deviceErrorCode?: unknown; ownerPid?: unknown } } : undefined;
    super(typeof value === "string" ? value : typeof error?.message === "string" ? error.message : `Request failed (${status})`);
    this.code = typeof error?.code === "string" ? error.code : undefined;
    this.reason = typeof error?.details?.reason === "string" ? error.details.reason : undefined;
    this.ownedByAnotherInstance = error?.code === "DEVICE_BUSY" && Number.isSafeInteger(error.details?.ownerPid) && (error.details?.ownerPid as number) > 0;
    this.signatureRejected = error?.code === "COMMAND_FAILED" && error.details?.reason === "signature-rejected";
    this.deviceErrorCode = typeof error?.details?.deviceErrorCode === "string" && /^\d{1,12}$/.test(error.details.deviceErrorCode)
      ? error.details.deviceErrorCode : undefined;
    if (error?.code === "DEVICE_BUSY" && (error.details?.state === "stopping" || error.details?.state === "recovering")) {
      this.controlStatus = error.details.state;
    }
  }

  messageFor(chinese: boolean): string {
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "database-active-journal") return chinese
      ? "数据库带有 WAL 或 journal 文件，暂时无法验证一致性，未读取数据。请使用应用导出的一致备份；停止写入或关闭数据库后，系统仍可能保留这些文件。"
      : "WAL or journal files prevent verification of a consistent snapshot. No data was read. Use a consistent backup exported by the app; these files may remain after writes stop or the database closes.";
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "database-directory-truncated") return chinese
      ? "数据库所在目录超出扫描上限，无法核实快照一致性，未读取数据。请使用应用导出的一致备份。"
      : "The database directory exceeds the scan limit, so snapshot consistency could not be verified. No data was read. Use a consistent backup exported by the app.";
    if (this.code === "STALE_SNAPSHOT" && this.reason === "database-id-expired") return chinese
      ? "数据库列表已更新，请重新扫描并选择该应用的数据库。"
      : "The database list changed. Rescan and select the application's database again.";
    if (this.code === "STALE_SNAPSHOT" && this.reason === "database-file-unavailable") return chinese
      ? "数据库文件已变化、不可读取或超过 64 MiB 快照上限，未读取数据。请重新扫描，或使用应用导出的一致备份。"
      : "The database file changed, became unreadable or exceeds the 64 MiB snapshot limit. No data was read. Rescan or use a consistent backup exported by the app.";
    if (this.code === "STALE_SNAPSHOT" && this.reason === "database-changed-during-capture") return chinese
      ? "数据库在采集过程中发生了变化，已丢弃本次副本。请停止写入后刷新，或使用应用导出的一致备份。"
      : "The database changed during capture; the copies were discarded. Stop writes and refresh, or use a consistent backup exported by the app.";
    if (this.code === "COMMAND_FAILED" && this.reason === "hdc-channel-not-ready") return chinese
      ? "设备调试通信尚未就绪。请重新连接 USB 并确认手机调试授权，或检查无线连接，然后刷新设备。"
      : "Device debugging communication is not ready. Reconnect USB and confirm debugging authorization, or check Wi-Fi, then refresh devices.";
    if (this.reason === "hap-preview-changed") return chinese ? "安装包在预览后发生了变化，未发送安装命令。请重新预览并确认。" : "The package changed after preview. No install command was sent. Preview and confirm it again.";
    if (this.reason === "hap-preview-invalid") return chinese ? "无法读取此 HAP 的应用信息，请选择有效的 HAP 安装包。" : "Cannot read this HAP's application metadata. Select a valid HAP package.";
    if (chinese && this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "inaccessible") return "无法读取这个设备目录：当前调试连接没有访问权限。请使用可访问的目录；调试应用沙箱需要调试签名且应用已启动。";
    if (chinese && this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "missing") return "设备路径不存在，请检查完整路径。";
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "mirror-component-missing") return chinese
      ? "实时视频组件尚未初始化；正在尝试兼容投屏。需要实时视频时，请点击“启用实时视频”。"
      : "The live video component is not initialized; trying compatible mirroring. Select Enable live video when you need it.";
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "mirror-package-invalid") return chinese
      ? "投屏组件缺少可用的前台入口。请重新安装有效的投屏组件。"
      : "The capture package has no supported foreground entry. Reinstall a valid capture component.";
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "mirror-local-signing-unavailable") return chinese
      ? "无法为当前手机生成私有投屏组件。请运行 devecocli auth login，保持手机已连接并解锁，然后重新初始化；Piora 会自动生成或更新设备调试 Profile。"
      : "Piora could not create the private capture component. Run devecocli auth login, keep this phone connected and unlocked, then initialize again; Piora will generate or update its device debug profile.";
    if (this.code === "CAPABILITY_UNAVAILABLE" && this.reason === "mirror-private-package-invalid") return chinese
      ? "本机签名后的投屏组件与随包版本不一致，未向手机发送安装命令。请重新安装 Piora 后重试。"
      : "The locally signed capture component differs from the bundled version. No install command was sent. Reinstall Piora and try again.";
    if (this.code === "OBSERVATION_UNAVAILABLE" && this.reason === "mirror-device-identity-unavailable") return chinese
      ? "无法确认当前手机是否包含在 DevEco 调试 Profile 中，未发送安装命令。请重新连接手机后重试。"
      : "Piora could not verify that this phone is included in the DevEco debug profile. No install command was sent. Reconnect the phone and try again.";
    if (this.code === "OBSERVATION_UNAVAILABLE" && this.reason === "mirror-uninstallation-unverified") return chinese
      ? "旧投屏组件卸载后仍能被设备读取，已停止安装新版本。请在手机上确认旧组件已移除后重试。"
      : "The old capture component was still visible after uninstall, so the new version was not installed. Confirm its removal on the phone and try again.";
    if (this.code === "OBSERVATION_UNAVAILABLE" && this.reason === "mirror-installation-unverified") return chinese
      ? "投屏组件已安装，但版本或启动入口尚未核实，因此未启动。请刷新应用信息后重新初始化。"
      : "The capture package was installed, but its version or entry could not be verified. It was not launched. Refresh application information and initialize again.";
    if (this.signatureRejected) return (chinese
      ? "设备拒绝安装：HAP 签名校验未通过。请使用对这台设备有效的签名包，然后重试。"
      : "Installation rejected: the HAP signature is invalid for this device. Use a package signed for this device, then retry.")
      + (this.deviceErrorCode ? ` (${this.deviceErrorCode})` : "");
    if (this.code === "SCREEN_LOCKED" && this.reason === "app-launch-locked") return (chinese
      ? "手机已锁屏，设备拒绝启动应用。请在手机上手动解锁，再重新启动。"
      : "The locked phone rejected the app launch. Unlock it on the phone, then launch again.")
      + (this.deviceErrorCode ? ` (${this.deviceErrorCode})` : "");
    if (this.code === "SCREEN_LOCKED") return chinese
      ? "手机已锁屏。请手动解锁并保持亮屏，然后重试实时投屏。"
      : "The phone is locked. Unlock it and keep the screen on, then retry live mirroring.";
    if (this.controlStatus === "stopping") return chinese
      ? "设备正在停止操作，请等待清理完成后重试。"
      : "Device operations are stopping. Wait for cleanup to finish, then try again.";
    if (this.controlStatus === "recovering") return chinese
      ? "上次设备操作的清理尚未确认，请在连接诊断中检查并恢复设备。"
      : "Cleanup from the previous operation is unconfirmed. Check and recover the device in Diagnostics.";
    if (this.ownedByAnotherInstance) return chinese
      ? "设备正在被另一个 Piora 实例使用。请先在该实例中结束设备操作，再重试。"
      : "Another Piora instance is using this device. End device operations in that instance, then retry.";
    return this.message;
  }
}
