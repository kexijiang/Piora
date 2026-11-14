/** Capture settings are ceilings, never measured performance claims. */
export const MIRROR_PROFILE = Object.freeze({
  fps: 120,
  bitrate: 30 * 1024 * 1024,
  scale: 1,
  keyframeIntervalMs: 1000,
  // A 60 Hz idle refresh leaves scheduling headroom without forcing the
  // encoder to produce an additional duplicate every 8 ms.
  repeatIntervalMs: 16,
  // HDC may deliver several fresh frames in one callback. Age and bytes bound
  // latency; this capacity only protects against unusually large bursts.
  maxViewerPackets: 24,
  maxViewerBytes: 8 * 1024 * 1024,
  maxViewerAgeMs: 80,
  keyframeRequestIntervalMs: 250,
  // Ask for a new frame before a quiet encoder forces a client reconnect.
  idleKeyframeIntervalMs: 2000,
  reconnectGraceMs: 5000,
  startupTimeoutMs: 8000,
});

export function captureArguments(scale = MIRROR_PROFILE.scale): string {
  // The native encoder takes an integer divisor, not a fractional multiplier.
  if (![1, 2, 3, 4, 5].includes(scale)) throw new Error("Unsupported mirror scale divisor");
  const p = MIRROR_PROFILE;
  return `-scale ${scale} -frameRate ${p.fps} -bitRate ${p.bitrate} -p 5000 -iFrameInterval ${p.keyframeIntervalMs} -repeatInterval ${p.repeatIntervalMs}`;
}
