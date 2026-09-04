export type BrowserViewportBounds = { x: number; y: number; width: number; height: number };
type SetViewport = (bounds: BrowserViewportBounds, visible: boolean) => Promise<unknown>;

const HIDDEN_BOUNDS: BrowserViewportBounds = { x: 0, y: 0, width: 0, height: 0 };

/** Resize updates coalesce; hide/unmount never waits for an older IPC reply. */
export function createBrowserViewportSync(setViewport: SetViewport) {
  let disposed = false;
  let inFlight = false;
  let pending: BrowserViewportBounds | null = null;

  const hide = () => {
    pending = null;
    void setViewport(HIDDEN_BOUNDS, false).catch(() => {});
  };
  const flush = async () => {
    if (inFlight || disposed) return;
    inFlight = true;
    try {
      while (pending && !disposed) {
        const bounds = pending;
        pending = null;
        await setViewport(bounds, true);
      }
    } catch {
      // The next layout observation retries; never resurrect a disposed view.
    } finally {
      inFlight = false;
      if (pending && !disposed) void flush();
    }
  };

  return {
    sync(bounds: BrowserViewportBounds, visible: boolean) {
      if (disposed) return;
      if (!visible) { hide(); return; }
      pending = bounds;
      void flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hide();
    },
  };
}
