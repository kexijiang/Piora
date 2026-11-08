export const VIDEO_CONFIG = 2;
export const VIDEO_FRAME = 3;
export const MAX_PACKET_BYTES = 64 * 1024 * 1024;

export interface VideoConfiguration {
  codec: number;
  width: number;
  height: number;
  fps: number;
  sps: Uint8Array;
  pps: Uint8Array;
}

/** Incremental parsing with one allocation per fragmented packet, not per network chunk. */
export class VideoPacketReader {
  private header = new Uint8Array(8);
  private headerBytes = 0;
  private payload?: Uint8Array;
  private payloadBytes = 0;
  private type = 0;
  private length = 0;

  *push(bytes: Uint8Array): Generator<{ type: number; payload: Uint8Array }> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.headerBytes < 8) {
        const count = Math.min(8 - this.headerBytes, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count; offset += count;
        if (this.headerBytes !== 8) continue;
        const view = new DataView(this.header.buffer);
        this.type = view.getUint32(0); this.length = view.getUint32(4);
        if (this.length > MAX_PACKET_BYTES) throw new Error("Video packet exceeds its size limit");
        if (!this.length) { this.headerBytes = 0; yield { type: this.type, payload: new Uint8Array() }; continue; }
      }
      const count = Math.min(this.length - this.payloadBytes, bytes.length - offset);
      if (!this.payloadBytes && count === this.length) {
        const payload = bytes.subarray(offset, offset + count); offset += count;
        this.headerBytes = 0;
        yield { type: this.type, payload };
      } else {
        this.payload ??= new Uint8Array(this.length);
        this.payload.set(bytes.subarray(offset, offset + count), this.payloadBytes);
        offset += count; this.payloadBytes += count;
        if (this.payloadBytes !== this.length) continue;
        const payload = this.payload; this.payload = undefined;
        this.payloadBytes = 0; this.headerBytes = 0;
        yield { type: this.type, payload };
      }
    }
  }

  finish(): void {
    if (this.headerBytes || this.payloadBytes) throw new Error("Video connection ended inside a packet");
  }
}

export function parseVideoConfiguration(bytes: Uint8Array): VideoConfiguration {
  if (bytes.length < 13) throw new Error("Truncated video configuration");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codec = bytes[0], width = view.getUint32(1), height = view.getUint32(5), fps = view.getUint32(9);
  if (![0, 1, 2].includes(codec) || !width || !height || width > 16384 || height > 16384 || width * height > 33554432 || !fps || fps > 240) throw new Error("Invalid video configuration");
  const config: VideoConfiguration = { codec, width, height, fps, sps: new Uint8Array(), pps: new Uint8Array() };
  if (codec !== 0) return config;
  if (bytes.length < 17) throw new Error("Truncated AVC configuration");
  const sl = view.getUint16(13), pp = 15 + sl;
  if (sl < 4 || sl > 4096 || pp + 2 > bytes.length) throw new Error("Invalid AVC SPS");
  const pl = view.getUint16(pp);
  if (!pl || pl > 4096 || pp + 2 + pl !== bytes.length) throw new Error("Invalid AVC PPS");
  config.sps = bytes.slice(15, pp); config.pps = bytes.slice(pp + 2);
  return config;
}

export function annexB(unit: Uint8Array): Uint8Array {
  if (unit[0] === 0 && unit[1] === 0 && (unit[2] === 1 || unit[2] === 0 && unit[3] === 1)) return unit;
  const bytes = new Uint8Array(unit.length + 4); bytes.set([0, 0, 0, 1]); bytes.set(unit, 4); return bytes;
}

export function avcCodec(sps: Uint8Array): string {
  const nal = annexB(sps), offset = nal[2] === 1 ? 3 : 4;
  if ((nal[offset] & 31) !== 7 || nal.length < offset + 4) throw new Error("Invalid AVC profile");
  return `avc1.${Array.from(nal.subarray(offset + 1, offset + 4), value => value.toString(16).padStart(2, "0")).join("")}`;
}

export function avcKeyframe(config: VideoConfiguration, frame: Uint8Array): Uint8Array {
  const units = [annexB(config.sps), annexB(config.pps), annexB(frame)];
  const bytes = new Uint8Array(units.reduce((size, unit) => size + unit.length, 0));
  let offset = 0; for (const unit of units) { bytes.set(unit, offset); offset += unit.length; } return bytes;
}
