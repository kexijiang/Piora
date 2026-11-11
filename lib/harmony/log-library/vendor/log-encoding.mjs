// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
export const LOG_ENCODINGS = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030'];
export function validateLogEncoding(value = 'auto') {
  if (!LOG_ENCODINGS.includes(value)) throw Error('日志编码无效，请选择自动、UTF-8、UTF-16 或 GB18030');
  return value;
}
function readable(text) {
  if (text.includes('\0')) return false;
  let controls = 0;
  for (const char of text) { const code = char.charCodeAt(0); if (code < 32 && ![9,10,12,13,27].includes(code)) controls++; }
  return controls <= Math.max(1, text.length * .005);
}
async function validFileEncoding(path, encoding) {
  const decoder = new TextDecoder(encoding, { fatal: true });
  try { for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) if (!readable(decoder.decode(chunk, { stream: true }))) return { valid: false, binary: true }; return { valid: readable(decoder.decode()), binary: false }; }
  catch(error) { if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return { valid: false, binary: false }; throw error; }
}
export async function inspectLogEncoding(path, requested = 'auto', toolOutput = false) {
  validateLogEncoding(requested);
  const fd = await open(path, 'r'); let bytes;
  try { const sample = Buffer.alloc(65536), { bytesRead } = await fd.read(sample, 0, sample.length, 0); bytes = sample.subarray(0, bytesRead); } finally { await fd.close(); }
  const decode = (encoding, fatal = true) => new TextDecoder(encoding, { fatal }).decode(bytes, { stream: bytes.length === 65536 });
  let encoding = requested, guessed = false;
  if (encoding === 'auto') {
    if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
    else if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
    else {
      let even = 0, odd = 0; for (let at = 0; at < bytes.length; at++) if (!bytes[at]) at % 2 ? odd++ : even++;
      const pairs = Math.floor(bytes.length / 2);
      if (pairs >= 8 && odd / pairs > .5 && even / pairs < .05) encoding = 'utf-16le';
      else if (pairs >= 8 && even / pairs > .5 && odd / pairs < .05) encoding = 'utf-16be';
      else { encoding = 'utf-8'; if (!toolOutput) try { decode(encoding); } catch { try { decode('gb18030'); encoding = 'gb18030'; guessed = true; } catch { /* Preserve imperfect UTF-8 with an explicit replacement count. */ } } }
    }
  }
  // Validate the whole file, so a long ASCII prefix cannot hide GBK or invalid bytes later.
  if (requested === 'auto' && !toolOutput && ['utf-8','gb18030'].includes(encoding)) {
    const utf8 = await validFileEncoding(path,'utf-8');
    if (utf8.binary) return { text: false, encoding: 'utf-8' };
    if (utf8.valid) { encoding = 'utf-8'; guessed = false; }
    else { const gb = await validFileEncoding(path,'gb18030'); if (gb.binary) return { text: false, encoding: 'utf-8' }; encoding = gb.valid ? 'gb18030' : 'utf-8'; guessed = gb.valid; }
  }
  const sample = decode(encoding, false);
  return { text: readable(sample), encoding, encodingGuessed: guessed || (requested === 'auto' && encoding !== 'utf-8'), encodingWarning: encoding !== 'utf-8' ? `按 ${encoding.toUpperCase()} 读取，原始字节保留；若显示异常可指定编码重新导入。` : undefined };
}
