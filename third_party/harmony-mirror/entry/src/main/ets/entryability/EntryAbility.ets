import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import display from '@ohos.display';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { startServer, stopServer, setEncoderPaused, restartEncoder, reconfigureEncoder, CaptureConfig } from 'libscrcpy_capture.so';
import { capturePresence, stopMirrorCapture } from '../CaptureSession';
import { captureBackground } from '../CaptureBackground';
export default class EntryAbility extends UIAbility {
  private cfg: CaptureConfig = { width: 720, height: 1592, frameRate: 30, bitrate: 6000000, jpegQuality: 70 };
  private captureEdge: number = 1080;
  private displayChange = (_displayId: number): void => {
    const previousWidth = this.cfg.width;
    const previousHeight = this.cfg.height;
    if (!this.dimensions(this.captureEdge)) return;
    if (previousWidth === this.cfg.width && previousHeight === this.cfg.height) return;
    if (AppStorage.get<boolean>('mirrorCaptureRequested') !== true) return;
    const applied = reconfigureEncoder(this.cfg);
    if (applied) {
      AppStorage.set('mirrorStatus', `画面已适配 ${this.cfg.width} × ${this.cfg.height}`);
      return;
    }
    // Native reconfiguration fails closed and stops the capture. Do not retry
    // automatically because that would open a second system consent request.
    capturePresence.cancelRequest();
    AppStorage.set('mirrorCaptureRequested', false);
    captureBackground.stop();
    AppStorage.set('mirrorStatus', '屏幕旋转后视频链路重建失败，请重新开始共享');
  };
  private dimensions(edge: number): boolean {
    try {
      const screen = display.getDefaultDisplaySync();
      const scale = Math.min(1, edge / Math.min(screen.width, screen.height));
      this.cfg.width = Math.max(2, Math.floor(screen.width * scale / 2) * 2);
      this.cfg.height = Math.max(2, Math.floor(screen.height * scale / 2) * 2);
      return true;
    } catch (_) {
      hilog.error(0xA000, 'PioraMirror', 'default display geometry is unavailable');
      return false;
    }
  }
  onCreate(want: Want): void {
    captureBackground.bind(this.context);
    AppStorage.setOrCreate('mirrorServerReady', false);
    AppStorage.setOrCreate('mirrorStatus', '等待 Piora 连接；录屏授权由系统弹窗确认');
    this.dimensions(this.captureEdge);
    display.on('change', this.displayChange);
  }
  private beginServer(): void {
    const ok = startServer(53535, this.cfg, (present: boolean) => {
      capturePresence.presenceChanged(present);
      if (AppStorage.get<boolean>('mirrorCaptureRequested') !== true) {
        capturePresence.cancelRequest(); return;
      }
      if (!present) {
        // A viewer refresh closes its old connection before opening the next.
        // Keep the same consented capture briefly, without starting a new one.
        AppStorage.set('mirrorStatus', '等待 Piora 重新连接；持续断开将停止共享');
        return;
      }
      AppStorage.set('mirrorStatus', 'Piora 已连接；以桌面实际视频帧为准');
    }, (sub: number, body: ArrayBuffer) => {
      // View-only: all device input commands are intentionally ignored.
      if (sub === 0x40) { setEncoderPaused(true); return; }
      if (sub === 0x41) { setEncoderPaused(false); return; }
      if (sub === 0x43) { restartEncoder(); return; }
      if (sub !== 0x42 || body.byteLength !== 12) return;
      const params = new DataView(body);
      const edge = params.getInt32(0, false), bitrate = params.getInt32(4, false), fps = params.getInt32(8, false);
      if (edge < 240 || edge > 1080 || bitrate < 100000 || bitrate > 12000000 || fps < 1 || fps > 60) return;
      const oldFps = this.cfg.frameRate, oldBitrate = this.cfg.bitrate;
      const oldWidth = this.cfg.width, oldHeight = this.cfg.height;
      if (!this.dimensions(edge)) return;
      this.captureEdge = edge;
      this.cfg.bitrate = bitrate; this.cfg.frameRate = fps;
      if (oldWidth === this.cfg.width && oldHeight === this.cfg.height &&
          oldFps === fps && oldBitrate === bitrate) return;
      if (!reconfigureEncoder(this.cfg)) {
        capturePresence.cancelRequest();
        AppStorage.set('mirrorCaptureRequested', false);
        captureBackground.stop();
        AppStorage.set('mirrorStatus', '视频参数更新失败，请重新开始共享');
        return;
      }
      AppStorage.set('mirrorStatus', `视频参数已更新为 ${this.cfg.width} × ${this.cfg.height} / ${fps} fps`);
    });
    AppStorage.setOrCreate('mirrorServerReady', ok);
    if (!ok) AppStorage.set('mirrorStatus', '设备回环视频端口启动失败');
  }
  onNewWant(want: Want): void { this.beginServer(); }
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.getMainWindow().then(main => main.setWindowKeepScreenOn(true))
      .catch(() => { console.error('Piora mirror keep-screen-on request failed'); });
    stage.loadContent('pages/MirrorPage').then(() => this.beginServer())
      .catch(() => { console.error('Piora mirror window initialization failed'); });
  }
  onDestroy(): void {
    display.off('change', this.displayChange);
    capturePresence.dispose();
    stopMirrorCapture(); captureBackground.dispose(); stopServer();
  }
}
