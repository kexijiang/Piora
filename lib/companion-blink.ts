/** A short close, a brief hold, then a slower reopen. Time is in seconds. */
export function blinkClosure(time: number): number {
  const ease = (value: number) => value * value * (3 - 2 * value);
  if (time < 0 || time >= 0.26) return 0;
  if (time < 0.08) return ease(time / 0.08);
  if (time < 0.12) return 1;
  return 1 - ease((time - 0.12) / 0.14);
}

export function createCompanionBlink(random = Math.random) {
  let untilBlink = 2.8 + random() * 3;
  let progress = -1;
  let closure = 0;
  let wasSleeping = false;
  return (delta: number, sleeping: boolean, reducedMotion: boolean): number => {
    const step = Math.max(0, Math.min(delta, 0.1));
    if (reducedMotion) {
      progress = -1;
      wasSleeping = sleeping;
      return (closure = sleeping ? 1 : 0);
    }
    if (sleeping || wasSleeping) {
      closure += ((sleeping ? 1 : 0) - closure) * Math.min(1, step * 14);
      progress = -1;
      untilBlink = 2.8 + random() * 3;
      wasSleeping = sleeping || closure > 0.001;
      return closure;
    }
    if (progress < 0) {
      untilBlink -= step;
      if (untilBlink <= 0) progress = 0;
    }
    if (progress >= 0) {
      progress += step;
      closure = blinkClosure(progress);
      if (progress >= 0.26) {
        progress = -1;
        untilBlink = random() < 0.12 ? 0.18 : 2.8 + random() * 3;
      }
    }
    return closure;
  };
}
