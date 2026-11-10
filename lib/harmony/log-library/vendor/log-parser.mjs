// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { normalizeLog } from './log-query.mjs';
import { redactLog } from './logs.mjs';
const levels = { D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };
export function parseImportedLog(line, now = new Date()) {
  line = String(line).replace(/^\uFEFF/, '');
  if (line.trimStart().startsWith('{')) try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const message = typeof value.message === 'string' ? value.message : typeof value.msg === 'string' ? value.msg : line;
      return { ...normalizeLog({ ...value, level: levels[value.level] || value.level || 'unknown', message: redactLog(message), raw: redactLog(line) }), imported: true, parsed: true };
    }
  } catch {}
  // HiLog standard text: timestamp PID TID L DOMAIN TAG: message, and the
  // DevEco exported layout timestamp PID-TID DOMAIN/process/TAG L message.
  const standard = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([A-Z]?[0-9A-Fa-f]{4,8})\s+([^:]+):\s?(.*)$/);
  const exported = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)[-\s]+(\d+)\s+([A-Z]?[0-9A-Fa-f]{4,8}\/\S+)\s+([DIWEF])\s+(.*)$/);
  const hdc = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([A-Z]?[0-9A-Fa-f]{4,8}\/\S+):\s?(.*)$/);
  let value;
  if (standard) { const [, timestamp, pid, tid, level, domain, tag, message] = standard; value = { timestamp, pid: +pid, tid: +tid, level: levels[level], domain, tag, message }; }
  else if (exported) { const [, timestamp, pid, tid, tag, level, message] = exported; value = normalizeLog({ timestamp, pid: +pid, tid: +tid, tag, level: levels[level], message }); }
  else if (hdc) { const [, timestamp, pid, tid, level, tag, message] = hdc; value = normalizeLog({ timestamp, pid: +pid, tid: +tid, tag, level: levels[level], message }); }
  if (value) {
    const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    const parts = value.timestamp.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)$/);
    const dates = years.map(year => new Date(year, +parts[1] - 1, +parts[2], +parts[3], +parts[4], +parts[5], +(parts[6] + '000').slice(0, 3))).sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
    return { ...value, capturedAt: dates[0].toISOString(), message: redactLog(value.message), raw: redactLog(line), imported: true, parsed: true };
  }
  return { level: 'unknown', tag: '', message: redactLog(line), raw: redactLog(line), imported: true, parsed: false };
}

