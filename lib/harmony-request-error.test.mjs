import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { HarmonyRequestError } = await createJiti(import.meta.url).import("./harmony/request-error.ts");

test("missing video components and locked screens retain structured localized recovery guidance", () => {
  const missing = new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", message: "Initialize the phone video component", details: { reason: "mirror-component-missing" } }, 501);
  assert.match(missing.messageFor(true), /兼容投屏.*启用实时视频/);
  assert.match(missing.messageFor(false), /compatible mirroring.*Enable live video/);
  assert.match(new HarmonyRequestError({ code: "SCREEN_LOCKED", message: "Locked" }, 409).messageFor(true), /手机已锁屏.*手动解锁/);
  assert.match(new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", message: "The device directory is inaccessible", details: { reason: "inaccessible" } }, 501).messageFor(true), /没有访问权限.*调试签名/);
  assert.match(new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "missing" } }, 501).messageFor(true), /路径不存在/);
  assert.equal(new HarmonyRequestError({ code: "COMMAND_FAILED", message: "Real failure", details: { reason: "mirror-component-missing" } }, 502).messageFor(true), "Real failure", "an unrelated failure must not be relabeled as a missing component");
});

test("signature rejection gives actionable localized device evidence without trusting arbitrary codes", () => {
  const error = new HarmonyRequestError({ code: "COMMAND_FAILED", message: "Device rejected the package", details: {
    reason: "signature-rejected", deviceErrorCode: "9568257",
  } }, 502);
  assert.match(error.messageFor(true), /签名校验未通过.*9568257/);
  assert.match(error.messageFor(false), /signed for this device.*9568257/);
  assert.equal(error.controlStatus, undefined, "signature failure is not uncertain touch cleanup");
  const untrusted = new HarmonyRequestError({ code: "COMMAND_FAILED", details: {
    reason: "signature-rejected", deviceErrorCode: "<script>private-path</script>",
  } }, 502);
  assert.equal(untrusted.messageFor(true).includes("private-path"), false);
  assert.equal(new HarmonyRequestError({ code: "DEVICE_BUSY", message: "Busy", details: {
    reason: "signature-rejected", state: "recovering",
  } }, 409).signatureRejected, false);
});

test("capture package validation and post-install verification preserve distinct recovery steps", () => {
  const invalid = new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "mirror-package-invalid" } }, 501);
  assert.match(invalid.messageFor(true), /前台入口.*重新安装/);
  assert.match(invalid.messageFor(false), /foreground entry.*Reinstall/);
  const unverified = new HarmonyRequestError({ code: "OBSERVATION_UNAVAILABLE", details: { reason: "mirror-installation-unverified" } }, 503);
  assert.match(unverified.messageFor(true), /已安装.*未启动.*刷新应用信息/);
  assert.match(unverified.messageFor(false), /installed.*not launched.*Refresh/);
  const unrelated = new HarmonyRequestError({ code: "DEVICE_BUSY", message: "Real failure", details: { reason: "mirror-installation-unverified" } }, 409);
  assert.equal(unrelated.messageFor(true), "Real failure");
});

test("local signing and popup-free replacement failures have actionable localized guidance", () => {
  const signing = new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "mirror-local-signing-unavailable" } }, 501);
  assert.match(signing.messageFor(true), /devecocli auth login.*自动生成或更新.*设备调试 Profile/);
  const identity = new HarmonyRequestError({ code: "OBSERVATION_UNAVAILABLE", details: { reason: "mirror-device-identity-unavailable" } }, 503);
  assert.match(identity.messageFor(true), /无法确认当前手机.*未发送安装命令/);
  const privatePackage = new HarmonyRequestError({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "mirror-private-package-invalid" } }, 501);
  assert.match(privatePackage.messageFor(true), /本机签名.*未向手机发送安装命令/);
  const uninstall = new HarmonyRequestError({ code: "OBSERVATION_UNAVAILABLE", details: { reason: "mirror-uninstallation-unverified" } }, 503);
  assert.match(uninstall.messageFor(true), /旧投屏组件卸载.*停止安装新版本/);
});

test("channel readiness failures show localized reconnection guidance without claiming an action was undone", () => {
  const error = new HarmonyRequestError({ code: "COMMAND_FAILED", message: "HDC rejected the device command", details: { reason: "hdc-channel-not-ready" } }, 502);
  assert.match(error.messageFor(true), /调试通信尚未就绪.*刷新设备/);
  assert.match(error.messageFor(false), /communication is not ready.*refresh devices/);
  assert.doesNotMatch(error.messageFor(true), /未发送|已撤销|成功/);
  const unrelated = new HarmonyRequestError({ code: "DEVICE_BUSY", message: "Busy", details: { reason: "hdc-channel-not-ready", state: "recovering" } }, 409);
  assert.match(unrelated.messageFor(true), /清理尚未确认/);
});
test("locked application launches explain manual unlock without describing a video failure", () => {
  const error=new HarmonyRequestError({code:'SCREEN_LOCKED',message:'Unlock before launching',details:{reason:'app-launch-locked',deviceErrorCode:'10106102'}},409);
  assert.match(error.messageFor(true),/设备拒绝启动应用.*手动解锁/);
  assert.match(error.messageFor(false),/rejected the app launch.*Unlock/);
  assert.match(error.messageFor(true),/10106102/);
  assert.doesNotMatch(error.messageFor(true),/投屏|自动解锁|未发送/);
});

test("a foreign physical owner gives localized guidance without exposing process details or masking recovery", () => {
  const error = new HarmonyRequestError({ code: "DEVICE_BUSY", message: "Another application instance owns this physical device", details: { ownerPid: 32984 } }, 409);
  assert.match(error.messageFor(true), /另一个 Piora 实例.*结束设备操作.*重试/);
  assert.match(error.messageFor(false), /Another Piora instance.*End device operations.*retry/);
  assert.doesNotMatch(error.messageFor(true), /32984|强制|接管/);
  assert.match(new HarmonyRequestError({ code: "DEVICE_BUSY", details: { ownerPid: 32984, state: "recovering" } }, 409).messageFor(true), /清理尚未确认/);
  for (const ownerPid of [0, -1, "32984", NaN, Infinity, "<script>"]) {
    assert.equal(new HarmonyRequestError({ code: "DEVICE_BUSY", message: "Other busy reason", details: { ownerPid } }, 409).messageFor(true), "Other busy reason");
  }
  assert.equal(new HarmonyRequestError({ code: "COMMAND_FAILED", message: "Other failure", details: { ownerPid: 32984 } }, 502).messageFor(true), "Other failure");
});
