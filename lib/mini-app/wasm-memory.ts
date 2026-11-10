import { MINI_APP_LIMITS, MiniAppError } from "./limits";

/** Pin the module's linear memory maximum before instantiation, not after growth. */
export function limitMiniAppWasmMemory(input: Uint8Array): Uint8Array {
  if (input.byteLength > 8 * 1024 * 1024 || input.length < 8
    || input.slice(0, 8).some((value, i) => value !== [0, 97, 115, 109, 1, 0, 0, 0][i])) {
    throw new MiniAppError("RUNTIME", "Invalid runtime module");
  }
  const read = (cursor: { offset: number }, end: number): number => {
    let value = 0, scale = 1;
    for (let i = 0; i < 5 && cursor.offset < end; i++) {
      const byte = input[cursor.offset++]; value += (byte & 127) * scale;
      if (!(byte & 128)) {
        if (value > 0xffffffff) break;
        return value;
      }
      scale *= 128;
    }
    throw new MiniAppError("RUNTIME", "Invalid runtime memory declaration");
  };
  const encode = (value: number): number[] => {
    const bytes = [];
    do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
    return bytes;
  };
  const sections: Uint8Array[] = [input.slice(0, 8)];
  const cursor = { offset: 8 };
  let found = false;
  while (cursor.offset < input.length) {
    const start = cursor.offset, id = input[cursor.offset++], length = read(cursor, input.length), end = cursor.offset + length;
    if (end > input.length) throw new MiniAppError("RUNTIME", "Truncated runtime module");
    if (id === 5) {
      if (found || read(cursor, end) !== 1) throw new MiniAppError("RUNTIME", "Expected one runtime memory");
      found = true;
      const flags = read(cursor, end);
      if (flags !== 0 && flags !== 1) throw new MiniAppError("RUNTIME", "Shared or memory64 runtime is unsupported");
      const initial = read(cursor, end), previousMax = flags === 1 ? read(cursor, end) : 65_536;
      const maximum = Math.min(previousMax, MINI_APP_LIMITS.wasmBytes / 65_536);
      if (cursor.offset !== end || initial > maximum) throw new MiniAppError("RUNTIME", "Runtime initial memory exceeds policy");
      const payload = [1, 1, ...encode(initial), ...encode(maximum)];
      sections.push(new Uint8Array([5, ...encode(payload.length), ...payload]));
    } else sections.push(input.slice(start, end));
    cursor.offset = end;
  }
  if (!found) throw new MiniAppError("RUNTIME", "Runtime has no bounded local memory");
  const result = new Uint8Array(sections.reduce((sum, section) => sum + section.length, 0));
  let offset = 0;
  for (const section of sections) { result.set(section, offset); offset += section.length; }
  return result;
}
