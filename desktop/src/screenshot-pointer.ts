import type * as Koffi from "koffi" with { "resolution-mode": "import" };

/** Poll only while the user is dragging a screenshot selection. */
export class ScreenshotPointer {
  private readonly koffi: typeof Koffi = require("koffi"); // eslint-disable-line @typescript-eslint/no-require-imports
  private readonly user = this.koffi.load("user32.dll");
  private readonly keyState = this.user.func("int16_t __stdcall GetAsyncKeyState(int key)");

  leftButtonDown(): boolean {
    return (Number(this.keyState(0x01)) & 0x8000) !== 0;
  }
}
