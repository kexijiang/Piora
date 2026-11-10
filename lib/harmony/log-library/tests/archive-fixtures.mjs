// Apache-2.0; ported from dsh-harmoneydev-tools, see third_party/harmony-log-workbench/SOURCE.md.
import { crc32 } from 'node:zlib';
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
const vint = value => { const out = []; do { let next = value % 128; value = Math.floor(value / 128); if(value) next |= 128; out.push(next); } while(value); return Buffer.from(out); };
export function rar4Fixture(entries) {
 const header = (type, flags, body) => { const h = Buffer.alloc(7); h[2] = type; h.writeUInt16LE(flags,3); h.writeUInt16LE(7+body.length,5); const all = Buffer.concat([h,body]); all.writeUInt16LE(crc32(all.subarray(2)) & 65535,0); return all; };
 const chunks = [Buffer.from([82,97,114,33,26,7,0]),header(0x73,0,Buffer.alloc(6))];
 for (const [name,content] of entries) { const data=Buffer.from(content),n=Buffer.from(name),body=Buffer.alloc(25);body.writeUInt32LE(data.length,0);body.writeUInt32LE(data.length,4);body[8]=2;body.writeUInt32LE(crc32(data),9);body[17]=20;body[18]=0x30;body.writeUInt16LE(n.length,19);body.writeUInt32LE(0x20,21);chunks.push(header(0x74,0x8000,Buffer.concat([body,n])),data); }
 chunks.push(header(0x7b,0,Buffer.alloc(0)));return Buffer.concat(chunks);
}
export function rar5Fixture(entries) {
 const header=body=>{const data=Buffer.concat([vint(body.length),body]);return Buffer.concat([u32(crc32(data)),data]);};
 const chunks=[Buffer.from([82,97,114,33,26,7,1,0]),header(Buffer.from([1,0,0]))];
 for(const [name,content] of entries){const data=Buffer.from(content),n=Buffer.from(name),body=Buffer.concat([vint(2),vint(2),vint(data.length),vint(4),vint(data.length),vint(0x20),u32(crc32(data)),vint(0),vint(0),vint(n.length),n]);chunks.push(header(body),data);}
 chunks.push(header(Buffer.from([5,0,0])));return Buffer.concat(chunks);
}
