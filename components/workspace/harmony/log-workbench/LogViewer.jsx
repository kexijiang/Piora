// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
function SourceMatch({ text, ranges = [] }) {
  text = String(text || ''); const parts = []; let start = 0;
  for (const [from, until] of ranges.slice(0, 200)) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || from < start || until < from || from > text.length) continue;
    parts.push(text.slice(start, from), <mark className="source-selected-match" key={from}>{text.slice(from, Math.min(until, text.length)) || '\u200b'}</mark>); start = Math.min(until, text.length);
  }
  parts.push(text.slice(start)); return <>{parts}</>;
}
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { compilePattern, regexHelp } from '@/lib/harmony/log-library/vendor/log-query.mjs';
import { LogApplicationFilter } from './LogApplicationFilter.jsx';
import { useLogSearchHistory, LogSearchHistoryMenu } from './LogSearchHistory.jsx';
import { historyKeyAction, isComposingKey, nextCursor } from '@/lib/harmony/log-library/vendor/log-search-menu.mjs';
import { exportFilteredLogs } from '@/lib/harmony-log-download';
const viewerCache = new Map();
const columnNames = { timestamp: '时间', pid: 'PID:TID', level: '级别', domain: 'DOMAIN', process: '包名 / 进程', tag: 'TAG', message: '消息' };

function Highlight({ text, pattern }) {
  text = String(text ?? ''); const ranges = pattern?.ranges(text) || [];
  if (!ranges.length) return text;
  const parts = []; let start = 0;
  for (const [from, until] of ranges) { parts.push(text.slice(start, from), <mark key={from}>{text.slice(from, until)}</mark>); start = until; }
  parts.push(text.slice(start)); return parts;
}

export function LogViewer({ url, exportUrl, visible = true, live = false, initialWindow, refreshKey = 0, timeBasis = '本机采集时间', onAnalyze, sessionId, focusSourceLine, focusSourceMatch }) {
  const saved = focusSourceLine ? undefined : viewerCache.get(url);
  const [filters, setFilters] = useState(saved?.filters || { bundle: '', query: '', tag: '', domain: '', pid: '', tid: '', level: '', regex: false, caseSensitive: false, from: initialWindow?.from || '', until: initialWindow?.until || '' });
  const [debounced, setDebounced] = useState(filters), [offset, setOffset] = useState(saved?.offset || 0), [history, setHistory] = useState([]), [page, setPage] = useState(), [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false), [find, setFind] = useState(''), [findCase, setFindCase] = useState(false), [findRegex, setFindRegex] = useState(false), [cursor, setCursor] = useState(0);
  // Search history: same store as dshHarmony's live pane, so both log views offer
  // one shared list. `selected` starts false, so focusing a box never turns Enter
  // into "reuse an old entry".
  const queryHistory = useLogSearchHistory('filter'), findHistory = useLogSearchHistory('find');
  const [queryHistoryOpen, setQueryHistoryOpen] = useState(false), [queryCursor, setQueryCursor] = useState(0), [querySelected, setQuerySelected] = useState(false);
  const [findHistoryOpen, setFindHistoryOpen] = useState(false), [findCursor, setFindCursor] = useState(0), [findSelected, setFindSelected] = useState(false);
  const [fullRow, setFullRow] = useState(), [exporting, setExporting] = useState(false), [exportError, setExportError] = useState(''), [exportNotice, setExportNotice] = useState('');
  const [pageSize, setPageSize] = useState(saved?.pageSize || 500), [scrollTop, setScrollTop] = useState(saved?.scrollTop || 0), [viewportHeight, setViewportHeight] = useState(420), [detailHeight, setDetailHeight] = useState(220);
  const [columns, setColumns] = useState(saved?.columns || { timestamp: true, pid: true, level: true, domain: false, process: false, tag: true, message: true });
  const [compact, setCompact] = useState(saved?.compact ?? true);
  const rowHeight = compact ? 28 : 36, visibleColumns = Object.keys(columnNames).filter(key => columns[key]);
  const viewport = useRef(), currentView = useRef(), resetRef = useRef({ url, filter: JSON.stringify(saved?.filters || filters) });
  currentView.current = { filters, offset, pageSize, scrollTop, columns, compact };
  useEffect(() => () => { viewerCache.delete(url); viewerCache.set(url, currentView.current); while (viewerCache.size > 20) viewerCache.delete(viewerCache.keys().next().value); }, [url]);
  useEffect(() => { if (!viewport.current) return; const element = viewport.current; element.scrollTop = scrollTop; const observer = new ResizeObserver(() => setViewportHeight(Math.min(2000, element.clientHeight || 420))); observer.observe(element); return () => observer.disconnect(); }, [page]);
  const root = useRef(), findInput = useRef(), rows = useRef(new Map()), fullRequest = useRef();
  useEffect(() => { setFullRow(undefined); fullRequest.current?.abort(); return () => fullRequest.current?.abort(); }, [url, debounced, offset]);
  useEffect(() => { const t = setTimeout(() => setDebounced(filters), 250); return () => clearTimeout(t); }, [filters]);
  useEffect(() => { const key = JSON.stringify(debounced); if (resetRef.current.url !== url || resetRef.current.filter !== key) { resetRef.current = { url, filter: key }; setOffset(0); setHistory([]); setScrollTop(0); } }, [debounced, url]);
  useEffect(() => { if (initialWindow) setFilters(f => ({ ...f, from: initialWindow.from, until: initialWindow.until })); }, [initialWindow]);
  useEffect(() => {
    if (!visible) return; const controller = new AbortController(); let alive = true, timer;
    async function refresh() {
      try {
        const suffix = new URLSearchParams({ ...debounced, offset, limit: pageSize });
        const response = await fetch(url + '&' + suffix, { signal: controller.signal }), value = await response.json();
        if (!response.ok || value.error) throw Error(value.error || '日志读取失败');
        if (alive) { setPage(value); setError(''); if (live) timer = setTimeout(refresh, 2000); }
      } catch (e) { if (alive && e.name !== 'AbortError') setError(e.message); }
    }
    setPage(undefined); refresh(); return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [url, visible, live, debounced, offset, refreshKey, pageSize]);
  useEffect(() => {
    if (!visible || !page || !focusSourceLine) return;
    const index = page.entries.findIndex(row => row.sourceLine === focusSourceLine);
    if (index < 0) return;
    const top = index * rowHeight; setScrollTop(top); if (viewport.current) viewport.current.scrollTop = top;
    void readFull(index);
  }, [page, visible, focusSourceLine, focusSourceMatch?.column]);
  useEffect(() => {
    if (fullRow?.sourceLine !== focusSourceLine || !focusSourceMatch?.ranges?.length) return;
    const timer = setTimeout(() => {
      const mark = root.current?.querySelector('.source-selected-match');
      if (!mark) return;
      const range = document.createRange(); range.selectNodeContents(mark);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 0);
    return () => clearTimeout(timer);
  }, [fullRow, focusSourceLine, focusSourceMatch]);
  useEffect(() => {
    function key(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && root.current?.contains(document.activeElement)) { event.preventDefault(); setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); } }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  let pattern, findError;
  try { pattern = compilePattern(find, { regex: findRegex, caseSensitive: findCase }); } catch (e) { findError = e.message; }
  const matches = useMemo(() => {
    if (!pattern) return [];
    return (page?.entries || []).map((e, index) => ({ text: [columns.timestamp && (e.timestamp || e.capturedAt), columns.pid && `${e.pid ?? ''}:${e.tid ?? ''}`, columns.level && e.level, columns.domain && e.domain, columns.process && (e.bundle || e.process), columns.tag && e.tag, e.message].filter(Boolean).join(' '), index })).filter(e => pattern.test(e.text)).map(e => e.index);
  }, [page, find, findRegex, findCase, columns]);
  useEffect(() => { setCursor(0); }, [find, findCase, findRegex, page]);
  useEffect(() => { setFullRow(undefined); }, [page]);
  async function readFull(index) {
    fullRequest.current?.abort(); const controller = new AbortController(); fullRequest.current = controller;
    try { const response = await fetch(url + '&' + new URLSearchParams({ ...debounced, offset: offset + index, limit: 1, fullMessage: true }), { signal: controller.signal }), value = await response.json(); if (!response.ok || value.error) throw Error(value.error || '完整行读取失败'); if (!controller.signal.aborted) setFullRow(value.entries?.[0]); } catch (e) { if (!controller.signal.aborted) setError(e.message); }
  }
  async function exportFiltered() {
    if (exporting) return; setExporting(true); setExportError(''); setExportNotice('');
    try {
      const mode = await exportFilteredLogs(exportUrl + '&' + new URLSearchParams(debounced));
      setExportNotice(mode === 'saved' ? '筛选结果已保存' : '已发起下载，请在保存窗口中确认并核对文件。');
    } catch (e) { if (e.name !== 'AbortError') setExportError(e.message); }
    finally { setExporting(false); }
  }
  function move(delta) { const next = (cursor + delta + matches.length) % matches.length; setCursor(next); const top = matches[next] * rowHeight; if (viewport.current) viewport.current.scrollTop = top; setScrollTop(top); }
  const change = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  // Applying a history entry restores its pattern and flags but touches no other
  // filter (bundle, tag, level, time range stay as they are).
  const applyQueryHistory = entry => {
    setFilters(f => ({ ...f, query: entry.query, regex: Boolean(entry.regex), caseSensitive: Boolean(entry.caseSensitive) }));
    queryHistory.record(entry.query, entry.regex, entry.caseSensitive);
  };
  const applyFindHistory = entry => {
    setFind(entry.query); setFindRegex(Boolean(entry.regex)); setFindCase(Boolean(entry.caseSensitive));
    findHistory.record(entry.query, entry.regex, entry.caseSensitive);
  };
  const openQueryHistory = () => { setFindHistoryOpen(false); setQueryHistoryOpen(true); setQuerySelected(false); queryHistory.reload(); };
  const openFindHistory = () => { setQueryHistoryOpen(false); setFindHistoryOpen(true); setFindSelected(false); findHistory.reload(); };
  const queryHistoryKey = event => {
    if (isComposingKey(event)) return;
    const action = historyKeyAction(event, { open: queryHistoryOpen, cursor: queryCursor, count: queryHistory.entries.length, selected: querySelected });
    if (action === 'close') { event.preventDefault(); event.stopPropagation(); setQueryHistoryOpen(false); setQuerySelected(false); return; }
    if (action === 'up' || action === 'down') { event.preventDefault(); setQuerySelected(true); setQueryCursor(value => nextCursor(value, action === 'up' ? -1 : 1, queryHistory.entries.length)); return; }
    if (action === 'apply') { event.preventDefault(); event.stopPropagation(); const entry = queryHistory.entries[queryCursor]; if (entry) applyQueryHistory(entry); setQueryHistoryOpen(false); setQuerySelected(false); return; }
    if (event.key === 'Enter') { event.preventDefault(); queryHistory.record(filters.query, filters.regex, filters.caseSensitive); setQueryHistoryOpen(false); setQuerySelected(false); }
  };
  const findHistoryKey = event => {
    if (isComposingKey(event)) return;
    const action = historyKeyAction(event, { open: findHistoryOpen, cursor: findCursor, count: findHistory.entries.length, selected: findSelected });
    if (action === 'close') { event.preventDefault(); event.stopPropagation(); setFindHistoryOpen(false); setFindSelected(false); return; }
    if (action === 'up' || action === 'down') { event.preventDefault(); setFindSelected(true); setFindCursor(value => nextCursor(value, action === 'up' ? -1 : 1, findHistory.entries.length)); return; }
    if (action === 'apply') { event.preventDefault(); event.stopPropagation(); const entry = findHistory.entries[findCursor]; if (entry) applyFindHistory(entry); setFindHistoryOpen(false); setFindSelected(false); return; }
    if (event.key === 'Enter') { if (matches.length) { event.preventDefault(); move(event.shiftKey ? -1 : 1); } if (!findError && find.trim()) findHistory.record(find, findRegex, findCase); }
  };
  return <section className={'log-viewer' + (focusSourceLine ? ' source-jump-view' : '')} ref={root} tabIndex={0} aria-label="日志查看器，Ctrl+F 查找本页" style={{ '--log-row-height': rowHeight + 'px' }}>
    <div className="log-controls"><div className="log-primary-tools">
      <LogApplicationFilter sessionId={sessionId || new URL(url, globalThis.location?.href || 'http://localhost').searchParams.get('sessionId')} applications={page?.applications || []} value={filters.bundle || ''} onChange={value => change('bundle', value)}/>
      <div className="log-search-anchor" data-history-anchor="filter" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setQueryHistoryOpen(false); }}>
      <input aria-label="日志关键词" placeholder="过滤关键词" value={filters.query} maxLength={256}
        onChange={e => { setQuerySelected(false); change('query', e.target.value); }}
        onFocus={() => openQueryHistory()}
        onBlur={event => { if (event.relatedTarget && event.currentTarget.closest('[data-history-anchor]')?.contains(event.relatedTarget)) return; window.setTimeout(() => {
          setQueryHistoryOpen(false); setQuerySelected(false);
          // The filter applies as you type, so a keyword the person actually
          // looked at is history even without pressing Enter — same rule as the
          // live pane in dshHarmony.
          if (filters.query.trim()) queryHistory.record(filters.query, filters.regex, filters.caseSensitive);
        }, 120); }}
        onKeyDown={queryHistoryKey}/>
      {queryHistory.available && <button aria-label="过滤历史" aria-expanded={queryHistoryOpen} title="最近使用的筛选关键词" onClick={() => { if (queryHistoryOpen) { setQueryHistoryOpen(false); setQuerySelected(false); } else openQueryHistory(); }}>历史</button>}
    {queryHistoryOpen && queryHistory.available ? <LogSearchHistoryMenu entries={queryHistory.entries} cursor={queryCursor} onCursor={setQueryCursor}
      onPick={entry => { applyQueryHistory(entry); setQueryHistoryOpen(false); setQuerySelected(false); }}
      onRemove={queryHistory.remove} onClear={queryHistory.clear} onClose={() => { setQueryHistoryOpen(false); setQuerySelected(false); }} label="筛选搜索历史"/> : null}
      </div>
      <select aria-label="最低日志级别" value={filters.level} onChange={e => change('level', e.target.value)}><option value="">全部级别</option>{['debug', 'info', 'warn', 'error', 'fatal'].map(l => <option key={l} value={l}>{l} 及以上</option>)}</select>
    </div>
    <div className="log-secondary-tools">
      <input aria-label="过滤 TAG" placeholder="TAG" value={filters.tag} onChange={e => change('tag', e.target.value)} maxLength={256}/>
      <button aria-label="过滤区分大小写" aria-pressed={filters.caseSensitive} title="过滤区分大小写" onClick={() => change('caseSensitive', !filters.caseSensitive)}>Aa</button>
      <button aria-label="正则过滤" aria-pressed={filters.regex} title={regexHelp} onClick={() => change('regex', !filters.regex)}>.*</button>
      <button onClick={() => { setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); }}>查找 · Ctrl+F</button>
      <details className="offline-advanced"><summary>更多筛选{[filters.domain, filters.pid, filters.tid, filters.from, filters.until].filter(Boolean).length ? ' · 已启用' : ''}</summary><div className="offline-advanced-panel"><div className="log-filter-grid">{['domain', 'pid', 'tid'].map(key => <input key={key} aria-label={'过滤 ' + key.toUpperCase()} placeholder={key.toUpperCase()} value={filters[key]} onChange={e => change(key, e.target.value)} maxLength={256}/>)}</div><small className="muted">{timeBasis}</small><div className="log-filter-grid">{['from', 'until'].map(key => <label key={key}>{key === 'from' ? '开始' : '结束'}<input aria-label={key === 'from' ? '日志开始时间' : '日志结束时间'} type="datetime-local" value={filters[key] ? (() => { const date = new Date(filters[key]); return Number.isFinite(+date) ? new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : ''; })() : ''} onChange={e => change(key, e.target.value ? new Date(e.target.value).toISOString() : '')}/></label>)}</div><p className="muted">包名取自日志的明确归属；只有 PID 的历史日志归属未知。{regexHelp}</p></div></details>
      <button aria-label="清除过滤" title="清除全部过滤条件" onClick={() => setFilters({ bundle: '', query: '', tag: '', domain: '', pid: '', tid: '', level: '', regex: false, caseSensitive: false, from: '', until: '' })}>重置</button>
    </div>
    </div>{exportError && <p role="alert" className="notice error">{exportError}</p>}{exportNotice && <p role="status" className="notice">{exportNotice}</p>}
    {findOpen && <div className="log-find" role="search"><div className="row"><div className="log-search-anchor" data-history-anchor="find" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFindHistoryOpen(false); }}><input ref={findInput} aria-label="查找本页日志" placeholder="本页查找，不改变过滤结果" value={find} maxLength={256}
      onChange={e => { setFindSelected(false); setFind(e.target.value); }}
      onFocus={() => openFindHistory()}
      onBlur={event => { if (event.relatedTarget && event.currentTarget.closest('[data-history-anchor]')?.contains(event.relatedTarget)) return; window.setTimeout(() => { setFindHistoryOpen(false); setFindSelected(false); }, 120); }}
      onKeyDown={e => {
        if (isComposingKey(e)) return;
        findHistoryKey(e);
        // Escape is consumed here: closing the find bar (or its history) must not
        // reach the surrounding panel, which would close the whole workbench.
        if (e.key === 'Escape' && !findHistoryOpen) { e.preventDefault(); e.stopPropagation(); setFindOpen(false); setFind(''); }
      }}/>{findHistory.available && <button aria-label="查找历史" aria-expanded={findHistoryOpen} title="最近使用的查找关键词" onClick={() => { if (findHistoryOpen) { setFindHistoryOpen(false); setFindSelected(false); } else openFindHistory(); }}>历史</button>}
    {findOpen && findHistoryOpen && findHistory.available ? <LogSearchHistoryMenu entries={findHistory.entries} cursor={findCursor} onCursor={setFindCursor}
      onPick={entry => { applyFindHistory(entry); setFindHistoryOpen(false); setFindSelected(false); findInput.current?.focus(); }}
      onRemove={findHistory.remove} onClear={findHistory.clear} onClose={() => { setFindHistoryOpen(false); setFindSelected(false); }} label="查找搜索历史"/> : null}
      </div><button disabled={!matches.length} aria-label="上一个匹配行" onClick={() => move(-1)}>↑</button><button disabled={!matches.length} aria-label="下一个匹配行" onClick={() => move(1)}>↓</button><button aria-label="关闭查找" onClick={() => { setFindOpen(false); setFind(''); }}>×</button></div><div className="row"><label className="check"><input type="checkbox" checked={findCase} onChange={e => setFindCase(e.target.checked)}/>Aa</label><label className="check"><input type="checkbox" checked={findRegex} onChange={e => setFindRegex(e.target.checked)}/>.*</label><span className="muted">{matches.length ? cursor + 1 : 0}/{matches.length} 个匹配行 · 仅当前页；搜索全部日志请用过滤</span></div>{findError && <p role="alert" className="error">{findError}</p>}</div>}
    {error ? <p role="alert" className="notice error">{error}</p> : !page ? <p role="status">正在读取日志…</p> : <>
      <div className="log-status-line"><span className="muted">共 {page.total} 条 · 符合过滤 {page.filteredTotal} 条 · 本页 {page.entries.length ? offset + 1 : 0}–{offset + page.entries.length}</span>{!!page.logCollection?.warnings?.length && <details className="offline-log-warnings"><summary>范围与完整性 · {page.logCollection.warnings.length} 项</summary><div>{page.logCollection.warnings.map((warning, i) => <p className="muted" key={i}>{warning}</p>)}</div></details>}</div>
      <div className="log-page-tools"><label><select aria-label="每页日志条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setOffset(0); setHistory([]); setScrollTop(0); }}>{[100, 500, 1000].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select></label><button disabled={!offset} onClick={() => { setOffset(0); setHistory([]); setScrollTop(0); }}>首页</button><button disabled={!history.length} onClick={() => { setOffset(history.at(-1)); setHistory(h => h.slice(0, -1)); setScrollTop(0); }}>上一页</button><button disabled={page.nextOffset === null} onClick={() => { setHistory(h => [...h.slice(-999), offset]); setOffset(page.nextOffset); setScrollTop(0); }}>下一页</button><details className="offline-columns"><summary>列 / 行距</summary><div>{Object.entries(columnNames).map(([key, label]) => <label className="check" key={key}><input type="checkbox" aria-label={'显示列 ' + label} checked={columns[key]} disabled={key === 'message'} onChange={e => setColumns(value => ({ ...value, [key]: e.target.checked }))}/>{label}</label>)}<label className="check"><input type="checkbox" aria-label="紧凑行距" checked={compact} onChange={e => { setCompact(e.target.checked); setScrollTop(0); if (viewport.current) viewport.current.scrollTop = 0; }}/>紧凑行距</label></div></details>{exportUrl && <button className="export-filtered" title="导出全部筛选结果，包含分页以外的匹配日志" disabled={exporting} onClick={exportFiltered}>{exporting ? '正在导出…' : '导出筛选结果'}</button>}</div>
      <div ref={viewport} className="log-table-scroll log-virtual" onScroll={e => setScrollTop(e.currentTarget.scrollTop)}><table className="log-table" style={{ minWidth: 300 + visibleColumns.reduce((n, key) => n + ({ timestamp: 148, pid: 92, level: 56, domain: 78, process: 170, tag: 120 }[key] || 0), 0) }}><colgroup>{visibleColumns.map(key => <col key={key} style={key === 'message' ? {} : { width: { timestamp: 148, pid: 92, level: 56, domain: 78, process: 170, tag: 120 }[key] }}/>)}</colgroup><thead><tr>{visibleColumns.map(key => <th key={key}>{columnNames[key]}</th>)}</tr></thead><tbody>
        {(() => { const first = Math.min(page.entries.length, Math.max(0, Math.floor(scrollTop / rowHeight) - 4)), end = Math.min(page.entries.length, first + Math.ceil(viewportHeight / rowHeight) + 10); return <>
          {first > 0 && <tr aria-hidden="true" className="log-spacer"><td colSpan={visibleColumns.length} style={{ height: first * rowHeight }}/></tr>}
          {page.entries.slice(first, end).map((e, local) => { const index = first + local, values = { timestamp: e.timestamp || e.capturedAt, pid: `${e.pid ?? '—'}:${e.tid ?? '—'}`, level: e.level, domain: e.domain || '—', process: e.bundle || e.process || '归属未知', tag: e.tag || '—', message: e.message }; return <tr data-source-line={e.sourceLine} key={index} ref={node => node ? rows.current.set(index, node) : rows.current.delete(index)} tabIndex={0} onClick={() => readFull(index)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); readFull(index); } }} className={'log-' + e.level + (e.sourceLine === focusSourceLine ? ' source-focus' : '') + (find && matches[cursor] === index ? ' find-current' : '') + (fullRow?.sourceLine && fullRow.sourceLine === e.sourceLine ? ' log-selected' : '')}>{visibleColumns.map(key => <td key={key} title={values[key]}>{key === 'message' ? <><span className="log-message-preview"><Highlight text={e.message} pattern={pattern}/></span><button className="log-detail-button" onClick={event => { event.stopPropagation(); readFull(index); }}>详情</button></> : <Highlight text={values[key]} pattern={pattern}/>}</td>)}</tr>; })}
          {end < page.entries.length && <tr aria-hidden="true" className="log-spacer"><td colSpan={visibleColumns.length} style={{ height: (page.entries.length - end) * rowHeight }}/></tr>}
        </>; })()}
      </tbody></table>{!page.entries.length && <div className="empty">没有符合过滤的日志。请检查时间范围及采集状态。</div>}</div>
      {fullRow && <div className="box offline-log-detail" style={{ height: detailHeight }}><div className="offline-detail-resize" role="separator" aria-label="调整离线日志详情高度" aria-orientation="horizontal" tabIndex={0} onDoubleClick={() => setDetailHeight(220)} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.y = String(e.clientY); e.currentTarget.dataset.height = String(detailHeight); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setDetailHeight(Math.max(100, Math.min(window.innerHeight * .65, Number(e.currentTarget.dataset.height) + Number(e.currentTarget.dataset.y) - e.clientY))); }} onKeyDown={e => { if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setDetailHeight(h => Math.max(100, Math.min(window.innerHeight * .65, h + (e.key === 'ArrowUp' ? 24 : -24)))); } }}/><div className="row spread"><strong>{fullRow.tag} · {fullRow.sourceLine ? `原文件第 ${fullRow.sourceLine} 行` : '单条原记录'}</strong><div className="row">{onAnalyze && <button onClick={() => onAnalyze(fullRow, debounced)}>此行加入对话</button>}<button onClick={() => navigator.clipboard.writeText(fullRow.raw || fullRow.message).catch(() => setError('复制失败，请选择正文后复制'))}>复制完整行</button><button onClick={() => setFullRow(undefined)}>关闭</button></div></div><pre>{fullRow.sourceLine === focusSourceLine && focusSourceMatch ? <SourceMatch text={fullRow.raw || fullRow.message} ranges={focusSourceMatch.ranges}/> : fullRow.raw || fullRow.message}</pre>{fullRow.messageTruncated && <p className="muted">单条读取仍限制 8192 字符，更长内容请查看原始文件。</p>}</div>}

    </>}
  </section>;
}
