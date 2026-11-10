// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { TEXT_BYTES, PACKAGE_BYTES, importLimitLabel } from './log-limits.mjs';

export function libraryUrl(sessionId, path, params = {}) {
  if (!sessionId) throw Error('请先打开一个会话');
  return '/api/harmony/log-library/' + path + '?' + new URLSearchParams({ sessionId, ...params });
}
export async function libraryRequest(sessionId, path, { params, body, rawBody, ...options } = {}) {
  const response = await fetch(libraryUrl(sessionId, path, params), rawBody !== undefined ? { ...options, body: rawBody } : body === undefined ? options : { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) throw Error(value.error || '日志库不可用，请重试或检查应用日志');
  return value;
}
export async function importLogFile(file, sessionId, { signal, onProgress = () => {}, sourceKind = 'import', snapshot, groupId, encoding = 'auto' } = {}) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > (/\.(zip|gz|rar)$/i.test(file.name) ? PACKAGE_BYTES : TEXT_BYTES)) throw Error(importLimitLabel);
  let id;
  try {
    signal?.throwIfAborted();
    // Keep begin observable even if cancellation arrives while the server creates it.
    const started = await libraryRequest(sessionId, 'begin', { body: { name: file.name, size: file.size, sourceKind, snapshot, groupId, encoding } }); id = started.id;
    for (let start = 0, index = 0; start < file.size; start += 256 * 1024) {
      signal?.throwIfAborted(); const data = await file.slice(start, start + 256 * 1024).arrayBuffer();
      const result = await libraryRequest(sessionId, 'chunk', { params: { id, index: index++ }, method: 'POST', headers: { 'content-type': 'application/octet-stream' }, rawBody: data, signal });
      onProgress(result.received, file.size, '上传中');
    }
    signal?.throwIfAborted(); onProgress(file.size, file.size, '解析中');
    const timer = setInterval(() => { libraryRequest(sessionId, 'import-status', { params: { id }, signal }).then(value => onProgress(file.size, file.size, value.phase + (value.count ? ' · ' + value.count + ' 条' : ''))).catch(() => {}); }, 750);
    let value; try { value = await libraryRequest(sessionId, 'finish', { body: { id }, signal }); } finally { clearInterval(timer); }
    return value;
  } catch (error) { if (id) await libraryRequest(sessionId, 'abort', { body: { id } }).catch(() => {}); throw error; }
}
export function logAnalysisPrompt(file, row, filters = {}) {
  const line = row?.sourceLine;
  const labels = { query: '关键词', level: '级别', tag: 'TAG', domain: 'DOMAIN', pid: 'PID', tid: 'TID', from: '开始时间', until: '结束时间', regex: '正则', caseSensitive: '区分大小写' };
  const scope = line ? '' : Object.entries(filters).filter(([key, value]) => labels[key] && value !== '' && value !== false && value !== undefined)
    .map(([key, value]) => `${labels[key]}=${value === true ? '开启' : value}`).join('，');
  return `只分析日志，引用文件名和行号。\n文件：${file.name}${file.analysisPath ? `\n路径：${file.analysisPath}` : ''}${file.manifestPath ? `\n清单：${file.manifestPath}` : ''}${line ? `\n原文件行号：${line}\n日志内容：${String(row.raw || row.message || '').slice(0, 500)}` : scope ? `\n筛选范围：${scope}` : ''}\n\n问题：`;
}
export function appendLogDraft(input, text) {
  const state = input.state?.getSnapshot?.();
  if (!state) throw Error('当前宿主未提供草稿读取能力，请完整重启后重试');
  if (state.phase !== 'plain') throw Error('当前输入正在提交或处理命令，请稍后加入日志');
  if (state.occurrences?.length) throw Error('已有草稿包含引用，请先保存或发送后再加入日志');
  input.setDraft(state.draft ? state.draft + '\n\n' + text : text);
  input.focus?.();
}

export function selectionAnalysisPrompt(value) {
  return `只分析日志，引用文件名和行号。\n日志清单：${value.manifestPath}\n按需读取清单中的文件。\n\n问题：`;
}

// Compatibility for older clients.
export const directoryAnalysisPrompt = selectionAnalysisPrompt;
