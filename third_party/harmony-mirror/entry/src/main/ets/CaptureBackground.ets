import { common, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { isCaptureStarted, stopCapture } from 'libscrcpy_capture.so';

/** An ordinary recording task exists only for a capture actually authorized by the user. */
class CaptureBackground {
  private context: common.UIAbilityContext | undefined = undefined;
  private epoch: number = 0;
  private timer: number = -1;
  private taskId: number = -1;
  private deadline: number = 0;
  private listening: boolean = false;
  private ready: boolean = false;
  private cancelledIds: number[] = [];
  private onCancel = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    this.cancelledIds.push(info.id);
    if (this.cancelledIds.length > 16) this.cancelledIds.shift();
    if (this.taskId !== -1 && info.id === this.taskId) this.fail('系统已取消后台录屏，共享已停止；重新共享需要再次确认授权。');
  };
  private onSuspend = (info: backgroundTaskManager.ContinuousTaskSuspendInfo): void => {
    if (this.taskId !== -1 && info.continuousTaskId === this.taskId && info.suspendState) {
      this.fail('系统已暂停后台录屏，共享已停止；请在手机重新请求共享。');
    }
  };

  bind(context: common.UIAbilityContext): void {
    this.context = context;
    try {
      backgroundTaskManager.on('continuousTaskCancel', this.onCancel);
      this.listening = true;
      backgroundTaskManager.on('continuousTaskSuspend', this.onSuspend);
      this.ready = true;
    } catch (error) {
      hilog.error(0xA000, 'PioraCaptureBg', 'record task listener code=%{public}d', (error as BusinessError).code);
    }
  }

  stop(): void {
    this.epoch++;
    if (this.timer !== -1) { clearTimeout(this.timer); this.timer = -1; }
    const id = this.taskId, context = this.context;
    this.taskId = -1;
    if (id !== -1 && context) this.release(id, context);
  }

  dispose(): void {
    this.stop();
    if (this.listening) {
      try { backgroundTaskManager.off('continuousTaskCancel', this.onCancel); }
      catch (error) { hilog.error(0xA000, 'PioraCaptureBg', 'record cancel listener cleanup code=%{public}d', (error as BusinessError).code); }
      try { backgroundTaskManager.off('continuousTaskSuspend', this.onSuspend); }
      catch (error) { hilog.error(0xA000, 'PioraCaptureBg', 'record suspend listener cleanup code=%{public}d', (error as BusinessError).code); }
      this.listening = false;
    }
    this.context = undefined;
    this.ready = false;
  }

  private release(id: number, context: common.UIAbilityContext): void {
    // A late start may belong to an older ability/request. Release its exact id.
    backgroundTaskManager.stopBackgroundRunning(context, id)
      .then(() => hilog.info(0xA000, 'PioraCaptureBg', 'record background task stopped id=%{public}d', id))
      .catch((error: BusinessError) => hilog.error(0xA000, 'PioraCaptureBg', 'record background stop code=%{public}d', error.code));
  }

  private fail(message: string): void {
    this.stop(); stopCapture();
    AppStorage.setOrCreate('mirrorCaptureRequested', false);
    AppStorage.set('mirrorStatus', message);
  }

  request(): void {
    if (!this.ready) { this.fail('后台录屏状态监听不可用，共享已停止；请查看设备诊断。'); return; }
    this.stop(); this.deadline = Date.now() + 30000;
    const epoch = this.epoch;
    this.timer = setTimeout(() => this.check(epoch), 500);
  }

  private async check(epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    this.timer = -1;
    const started = isCaptureStarted();
    if (!started && this.taskId !== -1) {
      this.stop();
      AppStorage.setOrCreate('mirrorCaptureRequested', false);
      AppStorage.set('mirrorStatus', '系统录屏已结束；重新共享需要再次确认授权。');
      return;
    }
    if (!started && Date.now() >= this.deadline) {
      this.fail('共享授权未完成，请点击“开始共享屏幕”重新请求。'); return;
    }
    if (started && this.taskId === -1) {
      const context = this.context;
      if (!context) { this.fail('录屏组件已关闭，共享已停止。'); return; }
      try {
        const agent = await wantAgent.getWantAgent({
          wants: [{ bundleName: 'com.ohos.scrcpy.server', abilityName: 'EntryAbility' }],
          operationType: wantAgent.OperationType.START_ABILITY,
          requestCode: 1, wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
        });
        if (epoch !== this.epoch) return;
        if (!isCaptureStarted()) { this.fail('系统录屏已结束；请在手机重新请求共享。'); return; }
        const request = new backgroundTaskManager.ContinuousTaskRequest();
        request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_AV_PLAYBACK_AND_RECORD];
        request.backgroundTaskSubmodes = [backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_SCREEN_RECORD_NORMAL_NOTIFICATION];
        request.wantAgent = agent;
        const result = await backgroundTaskManager.startBackgroundRunning(context, request);
        const id = result.continuousTaskId;
        if (id === undefined || id < 0) throw new Error('Missing owned record task id');
        if (epoch !== this.epoch) { this.release(id, context); return; }
        if (!isCaptureStarted()) {
          this.release(id, context);
          this.fail('系统录屏已结束；请在手机重新请求共享。'); return;
        }
        if (this.cancelledIds.includes(id)) {
          this.release(id, context);
          this.fail('系统已取消后台录屏，共享已停止；请重新请求共享。'); return;
        }
        this.taskId = id;
        hilog.info(0xA000, 'PioraCaptureBg', 'record background task started id=%{public}d', id);
        AppStorage.set('mirrorStatus', '共享已启动；系统录屏通知维持后台传输');
      } catch (error) {
        hilog.error(0xA000, 'PioraCaptureBg', 'record background start code=%{public}d', (error as BusinessError).code);
        if (epoch === this.epoch) this.fail('无法保持后台录屏，共享已停止；请查看设备诊断后重新尝试。');
        return;
      }
    }
    if (epoch === this.epoch) this.timer = setTimeout(() => this.check(epoch), 500);
  }
}
export const captureBackground = new CaptureBackground();
