// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { spawn } from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname } from 'node:path';
import { path7z } from '7z-bin';

function launch(args, signal) {
  signal.throwIfAborted();
  const child = spawn(path7z, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'], signal });
  let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000); });
  const timer = setTimeout(() => child.kill(), 180000); timer.unref();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('RAR 解包失败：损坏、加密或缺少分卷；原包保留。' + diagnostic.slice(-1000))));
  }).finally(() => clearTimeout(timer));
  // A stream failure may finish before the process emits close.
  done.catch(() => {});
  return { child, done };
}
export function parseRarListing(text, safePath, budget, maximum, totalMaximum, maxEntries) {
  const values = [], seen = new Set(); let total = 0, count = 0;
  for (const record of text.split(/\r?\n\r?\n/)) {
    if (!record.trim()) continue;
    const item = {};
    for (const line of record.split(/\r?\n/)) {
      if (!line) continue;
      const at = line.indexOf(' ='); if (at < 1) throw Error('RAR 清单格式不完整');
      const key = line.slice(0,at); if (Object.hasOwn(item,key)) throw Error('RAR 含无法安全识别的文件名或重复清单字段'); item[key] = line.slice(at+2).replace(/^ /,'');
    }
    if (++count > maxEntries) throw Error('RAR 条目超过 10000');
    const original = item.Path || '', name = original.replaceAll('\\','/');
    if (/[@*?\x00-\x1f]/.test(name)) throw Error('RAR 含不安全或歧义文件名');
    const target = safePath(name), key = target.toLocaleLowerCase();
    if (seen.has(key)) throw Error('RAR 存在重复或大小写冲突路径'); seen.add(key);
    if (item.Encrypted === '+' || item['Symbolic Link'] || item['Hard Link'] || /Reparse|Symbolic|Hard Link/i.test(item.Characteristics || '') || /(?:^| )l[rwx-]{9}/.test(item.Attributes || '')) throw Error('不支持链接或加密 RAR');
    if (item['Split Before'] === '+' || item['Split After'] === '+') throw Error('RAR 缺少分卷，请先合并为完整压缩包');
    if (item.Folder === '+' || /^D/.test(item.Attributes || '')) continue;
    const size = Number(item.Size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum(name)) throw Error('RAR 单份展开内容超过限制');
    total += size; if (budget.bytes + total > totalMaximum) throw Error(`RAR 累计展开内容超过 ${totalMaximum / 1024 ** 3} GiB`);
    if (/\.(txt|log|jsonl|json|gz)$/i.test(name) || /^hilog_dict[^/\\]*\.zip$/i.test(name.split('/').at(-1))) values.push({ original, name, target, size });
  }
  return values;
}
export async function extractRar(source, destination, budget, signal, { safeEntry, byteLimit, textBytes, packageBytes, totalBytes, maxEntries }) {
  const fd = await open(source,'r'); const signature = Buffer.alloc(8);
  try { await fd.read(signature,0,8,0); } finally { await fd.close(); }
  if (!signature.subarray(0,6).equals(Buffer.from([82,97,114,33,26,7])) || ![0,1].includes(signature[6])) throw Error('文件不是有效 RAR 压缩包，原文件保留');
  const listing = launch(['l','-slt','-ba','-bd','-sccUTF-8','-p-','--',source],signal);
  let chunks = [], bytes = 0;
  try { for await (const chunk of listing.child.stdout) { bytes += chunk.length; if (bytes > 16*1024*1024) throw Error('RAR 清单超过 16 MiB'); chunks.push(chunk); } await listing.done; } catch(error) { listing.child.kill(); throw error; }
  const entries = parseRarListing(Buffer.concat(chunks).toString('utf8'), name => safeEntry(destination,name), budget, name => /\.gz$/i.test(name) || /^hilog_dict.*\.zip$/i.test(name.split('/').at(-1)) ? packageBytes : textBytes, totalBytes, maxEntries), paths = [];
  for (const entry of entries) {
    signal.throwIfAborted(); await mkdir(dirname(entry.target),{recursive:true});
    // Extract only to stdout: the archive cannot create links or choose filesystem destinations.
    const run = launch(['x','-so','-bd','-y','-p-','-spd','-ssc','--',source,entry.original],signal);
    try { await Promise.all([run.done, pipeline(run.child.stdout,byteLimit(budget,entry.size),createWriteStream(entry.target,{flags:'wx'}),{signal})]); }
    catch(error) { run.child.kill(); throw error; }
    if ((await stat(entry.target)).size !== entry.size) throw Error('RAR 解包长度与清单不一致，原包保留');
    paths.push(entry.target);
  }
  return paths;
}
