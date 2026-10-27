/** Read the displayed dimensions from an AVC SPS, including coded padding. */
export function avcSize(sps: Uint8Array): { width: number; height: number } | undefined {
  if (sps.length > 4096 || (sps[0] & 31) !== 7) return;
  const bytes: number[] = [];
  for (let i = 0; i < sps.length; i++) {
    if (i >= 2 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    bytes.push(sps[i]);
  }
  let position = 8;
  const bits = (count: number): number => {
    if (position + count > bytes.length * 8) throw new Error("Truncated SPS");
    let value = 0;
    while (count--) { value = value * 2 + ((bytes[position >> 3] >> (7 - (position & 7))) & 1); position++; }
    return value;
  };
  const ue = (): number => {
    let zeros = 0;
    while (!bits(1)) if (++zeros > 24) throw new Error("Invalid SPS integer");
    return 2 ** zeros - 1 + bits(zeros);
  };
  const se = () => { const n = ue(); return n % 2 ? (n + 1) / 2 : -n / 2; };
  try {
    const profile = bits(8); bits(16); ue();
    let chroma = 1, separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma > 3) return;
      if (chroma === 3) separate = bits(1);
      ue(); ue(); bits(1);
      if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + se() + 256) % 256;
          last = next || last;
        }
      }
    }
    ue();
    const order = ue();
    if (order === 0) ue();
    else if (order === 1) { bits(1); se(); se(); const cycle = ue(); if (cycle > 255) return; for (let i = 0; i < cycle; i++) se(); }
    else if (order !== 2) return;
    ue(); bits(1);
    const columns = ue() + 1, rows = ue() + 1, frame = bits(1);
    if (!frame) bits(1);
    bits(1);
    let width = columns * 16, height = rows * 16 * (2 - frame);
    if (bits(1)) {
      const left = ue(), right = ue(), top = ue(), bottom = ue();
      const array = separate ? 0 : chroma;
      width -= (array === 0 || array === 3 ? 1 : 2) * (left + right);
      height -= (array === 1 ? 2 : 1) * (2 - frame) * (top + bottom);
    }
    if (width > 0 && height > 0 && width <= 16384 && height <= 16384) return { width, height };
  } catch { /* Reject malformed metadata without blocking future keyframes. */ }
}
