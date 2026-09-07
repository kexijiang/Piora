/** Keep a requested bottom jump anchored while virtual rows and lazy content settle. */
export function followChatBottom(container: HTMLElement, pin: () => void): () => void {
  let frame = 0;
  let stopped = false;
  const update = () => { frame = 0; if (!stopped) pin(); };
  const schedule = () => { if (!stopped && !frame) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  if (container.firstElementChild) resize.observe(container.firstElementChild);
  const mutation = new MutationObserver(schedule);
  mutation.observe(container, { childList: true, subtree: true });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    resize.disconnect();
    mutation.disconnect();
    container.removeEventListener("load", schedule, true);
    container.removeEventListener("wheel", cleanup);
    container.removeEventListener("touchstart", cleanup);
    container.removeEventListener("pointerdown", cleanup);
    container.removeEventListener("keydown", onKeyDown);
    if (frame) cancelAnimationFrame(frame);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cleanup();
  };
  container.addEventListener("load", schedule, true);
  container.addEventListener("wheel", cleanup, { passive: true });
  container.addEventListener("touchstart", cleanup, { passive: true });
  container.addEventListener("pointerdown", cleanup, { passive: true });
  container.addEventListener("keydown", onKeyDown);
  update();
  schedule();
  return cleanup;
}
