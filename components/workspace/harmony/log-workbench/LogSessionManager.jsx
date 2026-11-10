// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import React, { useEffect, useRef, useState } from 'react';
import { libraryRequest as request } from '@/lib/harmony/log-library/vendor/log-client.mjs';

const size = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GiB' : (value / 1048576).toFixed(2) + ' MiB';
export function LogSessionManager({ sessionId, visible, onClose, onChanged }) {
  const [page, setPage] = useState(), [query, setQuery] = useState(''), [debounced, setDebounced] = useState(''), [offset, setOffset] = useState(0), [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(new Set()), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(false), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const timer = setTimeout(() => { setDebounced(query); setOffset(0); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setSelected(new Set()); }, [debounced]);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController(); setLoading(true); setError('');
    request(sessionId, 'management/sessions', { params: { query: debounced, offset, limit: 50 }, signal: abort.signal }).then(value => {
      if (abort.signal.aborted) return;
      setPage(value); if (offset && offset >= value.total) setOffset(0);
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [sessionId, visible, debounced, offset, tick]);
  async function removeSelected() {
    if (running.current || !selected.size) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(sessionId, 'management/delete', { body: { sessionIds: [...selected] } });
      if (!alive.current) return;
      setSelected(new Set()); setTick(value => value + 1); onChanged(result);
      setNotice(`已删除 ${result.removed} 份日志。`);
      if (result.errors.length) setError(result.errors.map(row => `${row.sessionId}${row.id ? ' / ' + row.id : ''}：${row.error}`).join('\n'));
    } catch (error) { if (alive.current) { setError(error.message); setTick(value => value + 1); } }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const allPage = !!page?.sessions.length && page.sessions.every(row => selected.has(row.sessionId));
  return <section className="log-session-manager" aria-label="全部会话日志管理" aria-busy={busy || loading}>
    <header className="row spread"><h3>全部会话日志管理</h3><button disabled={busy} onClick={onClose}>返回当前会话</button></header>
    <p className="muted">删除所选会话的日志副本及旧版本删除残留；保留对话、截图、录屏和用户原文件。</p>
    <div className="row log-manager-tools"><input aria-label="搜索日志所属会话" placeholder="搜索会话名称或 ID" maxLength={256} disabled={busy} value={query} onChange={event => setQuery(event.target.value)}/><button disabled={busy || loading} onClick={() => setTick(value => value + 1)}>刷新会话</button><span>已选 {selected.size} 个会话{selected.size ? '（含其它分页）' : ''}</span><button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>取消选择</button></div>
    {page && <p className="muted">{page.total} 个会话 · {page.totals.files + page.totals.trashFiles} 份日志 · 估算占用 {size(page.totals.bytes + page.totals.trashBytes)}{page.totals.trashFiles ? `（含旧版本残留 ${page.totals.trashFiles} 份）` : ''}</p>}
    <div className="row log-manager-actions"><button disabled={busy || loading || !selected.size} onClick={removeSelected}>{busy ? '正在删除…' : '删除所选会话日志'}</button><span className="muted">每次最多 200 个会话、10000 份日志；导入或解析中的会话会跳过并提示。</span></div>
    {error && <p role="alert" className="notice error log-manager-error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <div className="log-manager-table-scroll"><table className="log-manager-table"><thead><tr><th><input type="checkbox" aria-label="全选本页会话" disabled={busy || loading || !page?.sessions.length} checked={allPage} onChange={event => setSelected(values => { const next = new Set(values); for (const row of page.sessions) if (event.target.checked) next.add(row.sessionId); else next.delete(row.sessionId); return next; })}/></th><th>会话</th><th>日志数</th><th>估算占用</th><th>最近导入</th></tr></thead><tbody>
      {page?.sessions.map(row => <tr key={row.sessionId}><td><input type="checkbox" aria-label={'选择会话 ' + row.name} disabled={busy || loading} checked={selected.has(row.sessionId)} onChange={event => setSelected(values => { const next = new Set(values); if (event.target.checked) next.add(row.sessionId); else next.delete(row.sessionId); return next; })}/></td><td><strong>{row.name}</strong>{row.sessionId === sessionId && <span className="badge">当前会话</span>}<small>{row.sessionId}{!row.nameAvailable && ' · 会话名称不可用'}</small></td><td>{row.files + row.trashFiles} 份{row.trashFiles > 0 && <small>旧版残留 {row.trashFiles} 份</small>}</td><td>{size(row.bytes + row.trashBytes)}</td><td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '—'}</td></tr>)}
    </tbody></table>{!loading && page && !page.sessions.length && <p className="empty">没有符合条件的会话日志。</p>}{loading && <p role="status">正在统计会话日志…</p>}</div>
    <footer className="row spread"><button disabled={busy || loading || !offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span>{page ? `${page.total} 个会话 · 第 ${Math.floor(offset / 50) + 1} 页` : ''}</span><button disabled={busy || loading || !page || page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></footer>
  </section>;
}
