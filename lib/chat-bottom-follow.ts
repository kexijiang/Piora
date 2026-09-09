const followers = new WeakMap<HTMLElement, { stop: () => void; pin: () => void }>();
export const CHAT_BOTTOM_FOLLOW_EVENT = "piora:chat-bottom-follow";

/** Virtual rows must settle against the same target as the scroll controller. */
export function isChatBottomFollowing(container: HTMLElement): boolean {
  return followers.has(container);
}

/** Reconcile a virtual-list commit before it can paint at the previous offset. */
export function pinChatBottom(container: HTMLElement): void {
  followers.get(container)?.pin();
}

/** Keep a requested bottom jump anchored while virtual rows and lazy content settle. */
export function followChatBottom(container: HTMLElement, pin: () => void): () => void {
  followers.get(container)?.stop();
  let frame = 0;
  let stopped = false;
  const update = () => { if (!stopped) pin(); };
  // ResizeObserver runs before paint. Deferring its correction to rAF lets
  // one frame show the old offset after code, images or virtual rows grow.
  const resize = new ResizeObserver(update);
  resize.observe(container);
  if (container.firstElementChild) resize.observe(container.firstElementChild);
  const mutation = new MutationObserver(update);
  mutation.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (followers.get(container) === follower) followers.delete(container);
    resize.disconnect();
    mutation.disconnect();
    container.removeEventListener("load", update, true);
    container.removeEventListener("wheel", cleanup);
    container.removeEventListener("touchstart", cleanup);
    container.removeEventListener("pointerdown", cleanup);
    container.removeEventListener("keydown", onKeyDown);
    if (frame) cancelAnimationFrame(frame);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cleanup();
  };
  container.addEventListener("load", update, true);
  container.addEventListener("wheel", cleanup, { passive: true });
  container.addEventListener("touchstart", cleanup, { passive: true });
  container.addEventListener("pointerdown", cleanup, { passive: true });
  container.addEventListener("keydown", onKeyDown);
  const follower = { stop: cleanup, pin: update };
  followers.set(container, follower);
  // A jump can happen without a React state change. Mount the virtual tail
  // immediately instead of waiting for a later native scroll event.
  container.dispatchEvent(new Event(CHAT_BOTTOM_FOLLOW_EVENT));
  update();
  frame = requestAnimationFrame(() => { frame = 0; update(); });
  return cleanup;
}
