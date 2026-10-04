import { stopCapture } from 'libscrcpy_capture.so';
import { CapturePresence } from './CapturePresence';
import { captureBackground } from './CaptureBackground';
export function stopMirrorCapture(): void {
  capturePresence.cancelRequest();
  AppStorage.setOrCreate('mirrorCaptureRequested', false);
  captureBackground.stop(); stopCapture();
}

// Both the ability and its page use the same session boundary.
export const capturePresence = new CapturePresence(() => {
  // Background/authorization failure may already have ended this request.
  // A late absence timer must preserve that final reason.
  if (AppStorage.get<boolean>('mirrorCaptureRequested') !== true) {
    capturePresence.cancelRequest(); return;
  }
  stopMirrorCapture();
  AppStorage.set('mirrorStatus', 'Piora 已断开，录屏会话已停止');
});
