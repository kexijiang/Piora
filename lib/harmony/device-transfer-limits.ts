/** File transfer bounds shared by local admission, frozen copies and HDC dispatch. */
export const MAX_DEVICE_TRANSFER_BYTES = 1024 * 1024 * 1024;

/** HDC has no reliable byte progress; larger files need a longer, bounded wall clock. */
export function deviceTransferTimeoutMs(size: number): number {
  return size > 256 * 1024 * 1024 ? 30 * 60_000 : 120_000;
}
