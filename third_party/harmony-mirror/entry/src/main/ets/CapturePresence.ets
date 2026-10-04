/** Keeps one consented session through a brief reconnect, never starts capture. */
export class CapturePresence {
  private connected: boolean = false;
  private requested: boolean = false;
  private epoch: number = 0;
  private timer: number = -1;
  private requestDeadline: number = 0;
  private onAbsent: () => void;

  constructor(onAbsent: () => void) { this.onAbsent = onAbsent; }

  private cancelTimer(): void {
    this.epoch++;
    if (this.timer !== -1) { clearTimeout(this.timer); this.timer = -1; }
  }

  private schedule(): void {
    const epoch = this.epoch;
    const delay = this.requestDeadline > 0 ? Math.max(0, this.requestDeadline - Date.now()) : 5000;
    this.timer = setTimeout(() => {
      if (!this.requested || this.connected || this.epoch !== epoch) return;
      this.timer = -1;
      this.requestDeadline = 0;
      this.requested = false;
      this.onAbsent();
    }, delay);
  }

  requestCapture(): void {
    // An explicit phone request must not inherit an older disconnect deadline.
    this.cancelTimer();
    if (this.requested) this.connected = false;
    this.requested = true;
    this.requestDeadline = this.connected ? 0 : Date.now() + 30000;
    if (!this.connected) this.schedule();
  }

  presenceChanged(present: boolean): void {
    // Repeated transport notices must not extend a request/disconnect deadline.
    if (this.connected === present) return;
    this.cancelTimer();
    this.connected = present;
    if (!this.requested) return;
    if (present) this.requestDeadline = 0;
    else this.schedule();
  }

  cancelRequest(): void {
    this.cancelTimer();
    // Stopping a requested capture closes its old TCP subscribers later.
    // Keep an idle viewer only: the first no-op Stop does not close that viewer.
    if (this.requested) this.connected = false;
    this.requested = false;
    this.requestDeadline = 0;
  }

  dispose(): void {
    this.cancelRequest();
    this.connected = false;
  }
}
