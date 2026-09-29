/** Convert HOScrcpy's raw H.264 callbacks to Piora's bounded video packet format. */
function nalUnits(bytes: Buffer): Buffer[] {
  const starts: Array<{ at: number; size: number }> = [];
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push({ at: index, size: 3 }); index += 2;
    } else if (index + 4 < bytes.length && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      starts.push({ at: index, size: 4 }); index += 3;
    }
  }
  if (!starts.length) return [bytes];
  return starts.map((start, index) => bytes.subarray(start.at + start.size, starts[index + 1]?.at ?? bytes.length)).filter(unit => unit.length > 0);
}

function packet(type: number, payload: Buffer): Buffer {
  const result = Buffer.allocUnsafe(8 + payload.length);
  result.writeUInt32BE(type, 0); result.writeUInt32BE(payload.length, 4); payload.copy(result, 8);
  return result;
}

export class HosVideoPacketizer {
  private sps?: Buffer;
  private pps?: Buffer;
  private configured = false;
  private width = 0;
  private height = 0;
  private timestamp = BigInt(0);

  setSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384) return;
    if (this.width !== width || this.height !== height) this.configured = false;
    this.width = width; this.height = height;
  }

  push(bytes: Buffer): Buffer[] {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return [];
    const units = nalUnits(bytes);
    for (const unit of units) {
      const type = unit[0] & 0x1f;
      if (type === 7) this.sps = Buffer.from(unit);
      if (type === 8) this.pps = Buffer.from(unit);
    }
    const output: Buffer[] = [];
    if (!this.configured && this.width && this.height && this.sps && this.pps && this.sps.length <= 4096 && this.pps.length <= 4096) {
      const config = Buffer.allocUnsafe(17 + this.sps.length + this.pps.length);
      config.writeUInt8(0, 0); config.writeUInt32BE(this.width, 1); config.writeUInt32BE(this.height, 5); config.writeUInt32BE(30, 9);
      config.writeUInt16BE(this.sps.length, 13); this.sps.copy(config, 15);
      config.writeUInt16BE(this.pps.length, 15 + this.sps.length); this.pps.copy(config, 17 + this.sps.length);
      output.push(packet(2, config)); this.configured = true;
    }
    const key = units.some(unit => (unit[0] & 0x1f) === 5);
    const picture = key || units.some(unit => (unit[0] & 0x1f) === 1);
    if (this.configured && picture) {
      const payload = Buffer.allocUnsafe(9 + bytes.length);
      payload.writeUInt8(key ? 1 : 0, 0);
      const now = BigInt(Date.now()) * BigInt(1000);
      this.timestamp = now > this.timestamp ? now : this.timestamp + BigInt(1);
      payload.writeBigUInt64BE(this.timestamp, 1); bytes.copy(payload, 9);
      output.push(packet(3, payload));
    }
    return output;
  }
}
