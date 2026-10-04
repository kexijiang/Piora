import { startCapture, CaptureConfig } from 'libscrcpy_capture.so';
import display from '@ohos.display';
import { capturePresence, stopMirrorCapture } from '../CaptureSession';
import { captureBackground } from '../CaptureBackground';

@Entry
@Component
struct MirrorPage {
  @StorageLink('mirrorStatus') status: string = '等待 Piora 连接';
  @StorageLink('mirrorServerReady') serverReady: boolean = false;

  private startSharing(): void {
    const screen = display.getDefaultDisplaySync();
    const scale = Math.min(1, 1080 / Math.min(screen.width, screen.height));
    const config: CaptureConfig = {
      width: Math.max(2, Math.floor(screen.width * scale / 2) * 2),
      height: Math.max(2, Math.floor(screen.height * scale / 2) * 2),
      frameRate: 30, bitrate: 6000000, jpegQuality: 70
    };
    stopMirrorCapture();
    const accepted = startCapture(config);
    AppStorage.setOrCreate('mirrorCaptureRequested', accepted);
    this.status = accepted
      ? '已请求共享。请确认系统授权，并在 Piora 查看实际画面。'
      : '共享请求失败。请查看 Piora 设备诊断后重新尝试。';
    if (accepted) {
      capturePresence.requestCapture();
      captureBackground.request();
    }
  }

  build() {
    Column({ space: 24 }) {
      Text('Piora 投屏').fontSize(28).fontWeight(FontWeight.Bold)
      Text('在电脑查看手机画面').fontSize(18)
      Text('画面通过本机调试连接传到 Piora。投屏只供观看，不接收鼠标、键盘或文字操作。')
        .fontSize(15).fontColor('#566274')
      Text(this.status).id('piora-mirror-status').fontSize(15)
      Button('开始共享屏幕').id('piora-mirror-start').width('100%')
        .enabled(this.serverReady)
        .onClick(() => this.startSharing())
      Button('停止共享').id('piora-mirror-stop').width('100%')
        .onClick(() => {
          stopMirrorCapture();
          this.status = '共享已停止。重新共享需要再次确认系统授权。';
        })
      Text('拒绝授权后不会自动重试。需要共享时，请再次点击上方按钮。')
        .fontSize(13).fontColor('#566274')
    }.padding(28).width('100%').height('100%')
      .justifyContent(FlexAlign.Center).backgroundColor('#F5F7FB')
  }
}
