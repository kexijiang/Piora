// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import React, { useEffect, useRef, useState } from 'react';
import { libraryRequest } from '@/lib/harmony/log-library/vendor/log-client.mjs';
import { historyKeyAction, isComposingKey, nextCursor } from '@/lib/harmony/log-library/vendor/log-search-menu.mjs';

const PAGE_SIZE = 100, MAX_BATCHES = 5, MAX_HISTORY = 30, COPY_BYTES = 32 * 1024 * 1024, COPY_ENTRIES = 100000;
const defaults = { query: '', mode: 'normal', caseSensitive: false, wholeWord: false, dotMatchesNewline: false, oneEntryPerLine: false, filePattern: '*' };
const modeLabels = { normal: '普通', extended: '扩展', regex: '正则表达式' };
const storageKey = sessionId => 'piora-session-file-search-v2:' + sessionId;
const rowKey = (batch, index) => batch.id + ':' + batch.offset + ':' + index;
const resultCount = page => Number.isFinite(page?.resultTotal) ? page.resultTotal : Number(page?.filteredTotal || 0);
function readHistory(sessionId) {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(sessionId)) || '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.query === 'string' && item.query.length <= 2048 && Object.hasOwn(modeLabels, item.mode))
      .slice(0, MAX_HISTORY).map(item => ({ ...defaults, ...item, filePattern: String(item.filePattern || '*').slice(0, 1024) })) : [];
  } catch { return []; }
}
function highlighted(row) {
  const text = String(row.message ?? ''), parts = []; let cursor = 0;
  // Patterns only run on the server. The UI applies trusted offsets, never a regex over original logs.
  const ranges = (Array.isArray(row.ranges) ? row.ranges : []).slice(0, 200).filter(range => Array.isArray(range)
    && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[1] >= range[0] && range[1] <= text.length)
    .sort((left, right) => left[0] - right[0]);
  ranges.forEach(([start, end], index) => {
    if (start < cursor) return;
    parts.push(text.slice(cursor, start));
    parts.push(<mark key={index} className={start === end ? 'session-search-zero-match' : undefined}>{start === end ? '▏' : text.slice(start, end)}</mark>);
    cursor = end;
  });
  parts.push(text.slice(cursor)); return parts;
}
function resultFingerprint(page) {
  return JSON.stringify([page.searchRevision ?? null, page.searchedFiles, page.matchedFiles, page.filteredTotal, page.totalHits, resultCount(page),
    page.fileMatches?.map(file => [file.id, file.count, file.hits]), page.summaryTruncated || false]);
}
async function clipboardWrite(text) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch { /* Desktop compatibility below. */ } }
  const previous = document.activeElement, element = document.createElement('textarea');
  element.value = text; element.readOnly = true; element.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.appendChild(element); element.select(); let copied = false;
  try { copied = document.execCommand('copy'); } finally { element.remove(); previous?.focus?.({ preventScroll: true }); }
  if (!copied) throw Error('当前宿主没有剪贴板写入权限，可直接选中结果文字复制。');
}

/** Bounded Find in Files results, scoped to one conversation; no client-side pattern execution. */
export function SessionLogSearch({ sessionId, visible, onOpenSource, onEnsureVisible }) {
  const [draft, setDraft] = useState({ ...defaults }), [batches, setBatches] = useState([]), [selected, setSelected] = useState();
  const [history, setHistory] = useState(() => readHistory(sessionId)), [historyOpen, setHistoryOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState(0), [historySelected, setHistorySelected] = useState(false);
  const [clearBeforeSearch, setClearBeforeSearch] = useState(false), [wrap, setWrap] = useState(false);
  const [conditionsOpen, setConditionsOpen] = useState(true);
  const [message, setMessage] = useState(''), [copyBusy, setCopyBusy] = useState(false);
  const root = useRef(), input = useRef(), results = useRef(), operation = useRef(), copyOperation = useRef();
  const batchesRef = useRef(batches), selectedRef = useRef(selected), sessionRef = useRef(sessionId), mounted = useRef(true), sequence = useRef(0), composing = useRef(false);
  batchesRef.current = batches; selectedRef.current = selected;
  function changeBatches(change) { setBatches(previous => { const value = change(previous); batchesRef.current = value; return value; }); }
  function updateBatch(id, change) { changeBatches(values => values.map(batch => batch.id === id ? change(batch) : batch)); }
  function cancelSearch(reason = '搜索已停止') {
    const pending = operation.current;
    if (pending) {
      pending.controller.abort(); operation.current = undefined;
      updateBatch(pending.id, batch => ({ ...batch, status: batch.page ? 'ready' : 'cancelled', notice: batch.page ? reason + '，保留上一次已完成的结果页。' : reason + '；尚未取得结果，不代表没有匹配。' }));
    }
    if (copyOperation.current) { copyOperation.current.abort(); copyOperation.current = undefined; setCopyBusy(false); setMessage('复制已停止，剪贴板未写入部分结果。'); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.controller.abort(); copyOperation.current?.abort(); }; }, []);
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    operation.current?.controller.abort(); operation.current = undefined; copyOperation.current?.abort(); copyOperation.current = undefined;
    sessionRef.current = sessionId; setBatches([]); setSelected(undefined); setHistory(readHistory(sessionId)); setHistoryOpen(false); setCopyBusy(false); setMessage('');
  }, [sessionId]);
  useEffect(() => { if (!visible) cancelSearch('视图已隐藏，搜索已停止'); }, [visible]);
  useEffect(() => {
    if (selected) results.current?.querySelector('[data-result-key="' + rowKey({ id: selected.batchId, offset: selected.offset }, selected.index) + '"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  function writeHistory(values) { setHistory(values); try { sessionStorage.setItem(storageKey(sessionId), JSON.stringify(values)); } catch { /* Optional browser storage. */ } }
  function remember(criteria) {
    setHistory(previous => {
      const key = JSON.stringify(criteria), values = [criteria, ...previous.filter(value => JSON.stringify(value) !== key)].slice(0, MAX_HISTORY);
      try { sessionStorage.setItem(storageKey(sessionId), JSON.stringify(values)); } catch { /* Optional browser storage. */ }
      return values;
    });
  }
  function chooseHistory(value) { setDraft({ ...defaults, ...value }); setConditionsOpen(true); setHistoryOpen(false); setHistorySelected(false); requestAnimationFrame(() => input.current?.focus()); }
  function selectRow(batch, index, open = false) {
    const row = batch.page?.entries[index]; if (!row) return;
    setSelected({ batchId: batch.id, offset: batch.offset, index });
    updateBatch(batch.id, value => ({ ...value, collapsed: false, collapsedFiles: value.collapsedFiles.filter(id => id !== row.fileId) }));
    if (open) onOpenSource(row.fileId, row.sourceLine, { column: row.column, ranges: row.ranges, occurrenceIndex: row.occurrenceIndex });
  }
  async function loadPage(id, criteria, offset = 0, options = {}) {
    cancelSearch('已开始另一项查找');
    const controller = new AbortController(), targetSession = sessionId, pending = { id, controller };
    operation.current = pending; updateBatch(id, value => ({ ...value, status: 'searching', notice: '', loadingOffset: offset }));
    try {
      const page = await libraryRequest(targetSession, 'search', { params: { ...criteria, offset, limit: PAGE_SIZE }, signal: controller.signal });
      if (controller.signal.aborted || !mounted.current || operation.current !== pending || sessionRef.current !== targetSession) return;
      if (page.sessionId !== targetSession) throw Error('日志搜索会话不匹配，已拒绝显示结果。');
      if (!Array.isArray(page.entries)) throw Error('日志搜索响应缺少结果列表，请完整重启后重试。');
      const existing = batchesRef.current.find(batch => batch.id === id);
      if (existing?.page && resultFingerprint(existing.page) !== resultFingerprint(page)) throw Error('日志文件或结果已发生变化，请重新“查找全部”；未把新结果拼接到旧批次。');
      operation.current = undefined;
      updateBatch(id, value => ({ ...value, page, offset, status: 'ready', notice: '', loadingOffset: undefined,
        previous: options.previous || (offset > value.offset ? [...value.previous, value.offset].slice(-500) : value.previous.filter(item => item < offset)) }));
      if (options.remember) { remember(criteria); setConditionsOpen(false); }
      if (page.entries.length && options.select) selectRow({ id, offset, page }, options.select === 'last' ? page.entries.length - 1 : 0, Boolean(options.open));
      else if (selectedRef.current?.batchId === id) setSelected(undefined);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || operation.current !== pending || sessionRef.current !== targetSession) return;
      operation.current = undefined;
      updateBatch(id, value => ({ ...value, status: value.page ? 'ready' : 'error', notice: (value.page ? '本次加载失败，下面仍是上一次已完成的结果页。' : '') + error.message }));
    }
  }
  function search() {
    if (composing.current) return;
    if (!draft.query.length) { setMessage('请输入要查找的内容；纯空格也可以查找。'); input.current?.focus(); return; }
    cancelSearch(); setMessage(''); setHistoryOpen(false); setHistorySelected(false); setSelected(undefined);
    const criteria = { ...draft, filePattern: draft.filePattern || '*' }, id = 'search-' + (++sequence.current);
    changeBatches(values => [{ id, criteria, createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }), status: 'searching', offset: 0, previous: [], collapsed: false, collapsedFiles: [] },
      ...(clearBeforeSearch ? [] : values.map(batch => ({ ...batch, collapsed: true })))].slice(0, MAX_BATCHES));
    void loadPage(id, criteria, 0, { remember: true });
  }
  function navigate(delta, open = true) {
    if (operation.current) return;
    const chosen = selectedRef.current, batch = batchesRef.current.find(value => value.id === chosen?.batchId && value.page) || batchesRef.current.find(value => value.page?.entries.length);
    if (!batch?.page?.entries.length) return;
    const current = chosen?.batchId === batch.id && chosen.offset === batch.offset ? chosen.index : delta > 0 ? -1 : batch.page.entries.length;
    const index = current + delta;
    if (index >= 0 && index < batch.page.entries.length) { selectRow(batch, index, open); return; }
    if (delta > 0 && batch.page.nextOffset !== null && batch.page.nextOffset !== undefined) void loadPage(batch.id, batch.criteria, batch.page.nextOffset, { select: 'first', open });
    else if (delta < 0 && batch.offset > 0) {
      // Address the preceding result, not an assumed 100-row page: response bytes can shorten pages.
      void loadPage(batch.id, batch.criteria, batch.offset - 1, { select: 'first', open });
    } else if (delta > 0) {
      if (batch.offset) void loadPage(batch.id, batch.criteria, 0, { select: 'first', open, previous: [] }); else selectRow(batch, 0, open);
      setMessage('已回到第一个结果。');
    } else {
      const last = Math.max(0, resultCount(batch.page) - 1);
      if (last >= batch.offset && last < batch.offset + batch.page.entries.length) selectRow(batch, last - batch.offset, open);
      else void loadPage(batch.id, batch.criteria, last, { select: 'first', open });
      setMessage('已回到最后一个结果。');
    }
  }
  function resultKeyDown(event) {
    if (isComposingKey(event)) return;
    // Native buttons keep their own Enter/click behavior instead of opening a previously selected hit.
    if (event.target !== results.current && event.target?.closest('button,a,input,select,textarea,summary')) return;
    const chosen = selectedRef.current, batch = batchesRef.current.find(value => value.id === chosen?.batchId);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); navigate(event.key === 'ArrowDown' ? 1 : -1, false); }
    else if (event.key === 'Enter' && batch && chosen.offset === batch.offset) { event.preventDefault(); event.stopPropagation(); selectRow(batch, chosen.index, true); }
    else if ((event.key === 'Home' || event.key === 'End') && batch?.page?.entries.length) { event.preventDefault(); event.stopPropagation(); selectRow(batch, event.key === 'Home' ? 0 : batch.page.entries.length - 1); }
  }
  useEffect(() => {
    function shortcut(event) {
      if (isComposingKey(event) || event.defaultPrevented) return;
      const ownsFocus = Boolean(root.current?.closest('.log-library')?.contains(document.activeElement));
      if (!visible && !ownsFocus) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); setConditionsOpen(true); onEnsureVisible?.(); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
      } else if (visible && event.key === 'F7') { event.preventDefault(); event.stopPropagation(); results.current?.focus(); }
      else if (visible && event.key === 'F4') { event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1); }
    }
    window.addEventListener('keydown', shortcut, true); return () => window.removeEventListener('keydown', shortcut, true);
  }, [visible, sessionId, onEnsureVisible]);
  async function copyRows(batch, fileId) {
    if (copyBusy || operation.current) return;
    const controller = new AbortController(), targetSession = sessionId, fingerprint = resultFingerprint(batch.page);
    copyOperation.current = controller; setCopyBusy(true); setMessage('正在核对原批次并收集完整结果，请稍候…');
    try {
      const original = await libraryRequest(targetSession, 'search', { params: { ...batch.criteria, offset: batch.offset, limit: PAGE_SIZE }, signal: controller.signal });
      if (original.sessionId !== targetSession || resultFingerprint(original) !== fingerprint || JSON.stringify(original.entries) !== JSON.stringify(batch.page.entries)) throw Error('原批次的日志或结果已改变，请重新查找后复制。');
      const lines = [], encoder = new TextEncoder(); let offset = 0, bytes = 0, count = 0;
      do {
        const page = offset === batch.offset ? original : await libraryRequest(targetSession, 'search', { params: { ...batch.criteria, offset, limit: PAGE_SIZE }, signal: controller.signal });
        if (page.sessionId !== targetSession || resultFingerprint(page) !== fingerprint) throw Error('复制期间日志或结果发生变化，已停止；请重新查找。');
        if (page.errors?.length) throw Error('搜索结果不完整，请先处理文件读取错误或缩小范围再复制完整结果。');
        for (const row of page.entries) {
          if (fileId && row.fileId !== fileId) continue;
          if (row.messageTruncated) throw Error('结果含被截断原行，请打开原文复制，避免省略内容被当成完整日志。');
          const text = String(row.message ?? ''); bytes += encoder.encode(text).length + 1; count++;
          if (count > COPY_ENTRIES || bytes > COPY_BYTES) throw Error('完整复制最多 100,000 条、32 MiB；请缩小文件范围或分批复制。');
          lines.push(text);
        }
        const next = page.nextOffset; if (next === null || next === undefined) break;
        if (!Number.isSafeInteger(next) || next <= offset) throw Error('分页游标无效，已停止复制。');
        offset = next;
        if (offset > COPY_ENTRIES * 10) throw Error('搜索范围过大，请缩小文件范围再复制。');
      } while (!controller.signal.aborted);
      if (controller.signal.aborted || !mounted.current || sessionRef.current !== targetSession) return;
      await clipboardWrite(lines.join('\n'));
      if (!controller.signal.aborted && mounted.current && sessionRef.current === targetSession) setMessage(`已复制 ${count} 条结果正文${fileId ? '（该文件）' : '（此批次）'}，不含分组头和行号。`);
    } catch (error) { if (!controller.signal.aborted && mounted.current && sessionRef.current === targetSession) setMessage(error.message); }
    finally { if (copyOperation.current === controller) { copyOperation.current = undefined; if (mounted.current) setCopyBusy(false); } }
  }
  function toggleAll(collapse) { changeBatches(values => values.map(batch => ({ ...batch, collapsed: collapse, collapsedFiles: collapse ? [...new Set(batch.page?.entries.map(row => row.fileId) || [])] : [] }))); }
  const busy = batches.some(batch => batch.status === 'searching'), selectedBatch = batches.find(batch => batch.id === selected?.batchId);
  const selectedRow = selectedBatch?.offset === selected?.offset ? selectedBatch?.page?.entries[selected?.index] : undefined;
  return <section ref={root} className="session-log-search session-search-notepad" aria-label="当前会话跨文件查找" onKeyDown={event => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (historyOpen) { setHistoryOpen(false); setHistorySelected(false); } else if (busy || copyBusy) cancelSearch(); else input.current?.focus(); }
  }}>
    <div className="session-search-heading"><strong>文件中查找</strong><span className="muted">当前会话全部已解析日志 · Ctrl+Shift+F</span><button type="button" aria-expanded={conditionsOpen} onClick={() => { setConditionsOpen(value => !value); setHistoryOpen(false); }}>{conditionsOpen ? '收起条件' : '展开条件'}</button></div>
    <form className="session-search-controls" hidden={!conditionsOpen} onSubmit={event => { event.preventDefault(); search(); }}>
      <label className="session-search-label" htmlFor={'session-search-query-' + sessionId}>查找目标</label>
      <div className="session-search-query" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setHistoryOpen(false); setHistorySelected(false); } }}>
        <input ref={input} id={'session-search-query-' + sessionId} aria-label="跨文件查找目标" autoComplete="off" maxLength={2048} value={draft.query} placeholder="输入关键词，Enter 查找全部" onChange={event => { setDraft(value => ({ ...value, query: event.target.value })); setHistorySelected(false); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
          if (isComposingKey(event)) return;
          const action = historyKeyAction(event, { open: historyOpen, cursor: historyCursor, count: history.length, selected: historySelected }); if (!action) return;
          event.preventDefault(); event.stopPropagation();
          if (action === 'close') { setHistoryOpen(false); setHistorySelected(false); }
          if (action === 'up' || action === 'down') { setHistorySelected(true); setHistoryCursor(value => nextCursor(value, action === 'up' ? -1 : 1, history.length)); }
          if (action === 'apply' && history[historyCursor]) chooseHistory(history[historyCursor]);
        }}/>
        <button type="button" className="session-search-history-toggle" aria-label="跨文件查找历史" aria-expanded={historyOpen} onClick={() => { setHistoryOpen(value => !value); setHistorySelected(false); setHistoryCursor(0); }}>▾</button>
        {historyOpen && <div className="session-search-history" role="group" aria-label="跨文件完整条件历史" onMouseDown={event => event.preventDefault()}>
          <div className="session-search-history-heading"><strong>最近查找条件</strong><span>{history.length}/{MAX_HISTORY}</span><button type="button" disabled={!history.length} onClick={() => { writeHistory([]); setHistorySelected(false); }}>清空</button><button type="button" aria-label="关闭跨文件历史" onClick={() => setHistoryOpen(false)}>×</button></div>
          {history.length ? <ul role="listbox" aria-label="跨文件条件历史">{history.map((value, index) => <li key={JSON.stringify(value)} role="option" aria-selected={historySelected && historyCursor === index}>
            <button type="button" className="session-search-history-value" onClick={() => chooseHistory(value)}><strong>{value.query}</strong><small>{modeLabels[value.mode]}{value.caseSensitive ? ' · 大小写' : ''}{value.wholeWord ? ' · 整词' : ''}{value.oneEntryPerLine ? ' · 每行一条' : ''} · {value.filePattern}</small></button>
            <button type="button" aria-label={'删除查找历史 ' + value.query} onClick={() => { writeHistory(history.filter((_, item) => item !== index)); setHistorySelected(false); }}>×</button>
          </li>)}</ul> : <p className="muted">完成查找后，完整条件会保留在本窗口当前会话中。</p>}
        </div>}
      </div>
      <div className="session-search-submit"><button className="primary" type="submit">查找全部</button><button type="button" disabled={!busy && !copyBusy} onClick={() => cancelSearch()}>停止</button></div>
      <label className="session-search-label" htmlFor={'session-search-files-' + sessionId}>文件过滤</label>
      <input id={'session-search-files-' + sessionId} aria-label="当前会话文件名通配过滤" maxLength={1024} value={draft.filePattern} onChange={event => setDraft(value => ({ ...value, filePattern: event.target.value }))} placeholder="*.log *.txt !*verbose*" title="仅当前会话文件名；*、?、! 排除；空格或分号分隔。"/>
      <span className="session-search-scope muted">范围：当前会话，不跨会话</span>
      <fieldset className="session-search-modes"><legend>搜索模式</legend>{Object.entries(modeLabels).map(([mode, label]) => <label key={mode}><input type="radio" name={'session-search-mode-' + sessionId} value={mode} checked={draft.mode === mode} onChange={() => setDraft(value => ({ ...value, mode }))}/>{label}{mode === 'extended' && <small>（\n、\r、\t…）</small>}</label>)}</fieldset>
      <div className="session-search-options"><label><input type="checkbox" checked={draft.wholeWord} onChange={event => setDraft(value => ({ ...value, wholeWord: event.target.checked }))}/>全词匹配</label><label><input type="checkbox" checked={draft.caseSensitive} onChange={event => setDraft(value => ({ ...value, caseSensitive: event.target.checked }))}/>区分大小写</label><label title="只对正则模式生效"><input type="checkbox" disabled={draft.mode !== 'regex'} checked={draft.dotMatchesNewline} onChange={event => setDraft(value => ({ ...value, dotMatchesNewline: event.target.checked }))}/>点匹配换行</label><label><input type="checkbox" checked={draft.oneEntryPerLine} onChange={event => setDraft(value => ({ ...value, oneEntryPerLine: event.target.checked }))}/>每行仅一条</label></div>
      <details className="session-search-help"><summary>语法与限制</summary><p>普通按原文查找；扩展将 \n、\r、\t 等转义转换为字符，可查跨行文本。文件过滤支持 *、? 和 ! 排除项，空格或分号分隔；本版不支持引号包裹含空格文件名。范围始终是当前会话全部已解析日志，不选择磁盘目录或其它会话。</p><p>正则使用 JavaScript 语法，与 Notepad++ 的 Boost 正则存在差异；后台工作线程最多执行 30 秒。跨行模式单文件最多 8,388,608 个字符，超过时列出文件错误并标记结果不完整；普通逐行查找不受此跨行上限限制。长行省略或高亮区间过多会明确标记，请打开原文核对。</p><p>F7 聚焦结果；↑/↓ 选择；双击或 Enter 打开原文；F4 / Shift+F4 前后跳转。完整复制有 100,000 条 / 32 MiB 上限，超限需缩小范围。清空结果不会删除日志。</p></details>
    </form>
    <div className="session-search-result-toolbar"><strong>查找结果</strong><button type="button" onClick={() => toggleAll(false)} disabled={!batches.length}>全部展开</button><button type="button" onClick={() => toggleAll(true)} disabled={!batches.length}>全部折叠</button><button type="button" disabled={!batches.length || copyBusy} onClick={() => { cancelSearch(); setBatches([]); setSelected(undefined); setMessage('已清空查找结果，日志文件未改变。'); }}>清空结果</button><button type="button" disabled={!selectedRow || copyBusy} onClick={() => { if (selectedRow) void clipboardWrite(String(selectedRow.message ?? '')).then(() => setMessage(selectedRow.messageTruncated ? '已复制当前预览正文；原行有省略，请打开原文复制完整行。' : '已复制选中行正文。')).catch(error => setMessage(error.message)); }}>复制选中行</button><label><input type="checkbox" checked={clearBeforeSearch} onChange={event => setClearBeforeSearch(event.target.checked)}/>每次搜索时清理</label><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/>自动换行</label></div>
    {message && <div className="session-search-message" role="status">{message}<button type="button" aria-label="关闭查找提示" onClick={() => setMessage('')}>×</button></div>}
    <div ref={results} className={'session-search-tree' + (wrap ? ' session-search-wrap' : '')} role="tree" aria-label="跨文件查找结果，搜索轮次、文件、命中" tabIndex={0} onKeyDown={resultKeyDown}>
      {!batches.length && <div className="session-search-empty">输入查找内容，按 Enter 或点击“查找全部”。<small>搜索当前会话全部已解析日志正文，包括压缩包中的文件，不受文件列表分页影响。</small></div>}
      {batches.map(batch => {
        const page = batch.page, groups = new Map();
        page?.entries.forEach((row, index) => { if (!groups.has(row.fileId)) groups.set(row.fileId, { name: row.fileName, rows: [] }); groups.get(row.fileId).rows.push({ row, index }); });
        return <div key={batch.id} className="session-search-batch" role="treeitem" aria-selected={false} aria-level={1} aria-expanded={!batch.collapsed}>
          <div className="session-search-batch-heading"><button type="button" className="session-search-disclosure" aria-label={(batch.collapsed ? '展开' : '折叠') + '查找 ' + batch.criteria.query} aria-expanded={!batch.collapsed} onClick={() => updateBatch(batch.id, value => ({ ...value, collapsed: !value.collapsed }))}>{batch.collapsed ? '▸' : '▾'}</button><button type="button" className="session-search-batch-label" onClick={() => updateBatch(batch.id, value => ({ ...value, collapsed: !value.collapsed }))}><strong>查找 “{batch.criteria.query}”</strong><span>{page ? `在 ${page.matchedFiles} 个文件中匹配 ${page.totalHits ?? page.filteredTotal} 次，${page.filteredTotal} 行；共查找 ${page.searchedFiles} 个文件` : batch.status === 'error' ? '查找失败' : batch.status === 'cancelled' ? '已停止' : '正在查找…'}</span></button><small>{batch.createdAt}</small><button type="button" title="将此批完整条件填回查找框，不立即执行" onClick={() => chooseHistory(batch.criteria)}>复用</button><button type="button" disabled={!page || busy || copyBusy} onClick={() => void copyRows(batch)}>复制此批正文</button></div>
          {!batch.collapsed && <div className="session-search-batch-content" role="group">
            <div className="session-search-batch-meta muted">{modeLabels[batch.criteria.mode]} · 文件：{batch.criteria.filePattern}{batch.criteria.wholeWord ? ' · 全词' : ''}{batch.criteria.caseSensitive ? ' · 区分大小写' : ''}{batch.criteria.oneEntryPerLine ? ' · 每行一条' : ' · 每次出现一条'}</div>
            {batch.status === 'searching' && <p className="session-search-progress" role="status">{page ? `正在加载第 ${batch.loadingOffset + 1} 条起的结果，暂保留已完成页…` : '正在后台查找全部文件…'}<button type="button" onClick={() => cancelSearch()}>停止</button></p>}
            {batch.notice && <p className="session-search-issue" role={batch.status === 'error' ? 'alert' : 'status'}>{batch.notice}</p>}
            {!!page?.errors?.length && <details className="session-search-errors"><summary>结果不完整：{page.errors.length} 份文件读取失败或超出限制</summary>{page.errors.map((file, index) => <p key={file.id || index}>{file.name || file.id}：{typeof file.error === 'string' ? file.error : file.error?.message || '读取失败'}</p>)}</details>}
            {page?.summaryTruncated && <p className="session-search-issue">文件汇总超过 1,000 份，仅展示部分汇总；匹配结果仍可翻页查看。</p>}
            {page && !page.entries.length && <p className="session-search-no-match">{page.errors?.length ? '已成功读取文件中没有匹配；失败文件未计为没有匹配。' : '没有匹配结果。'}</p>}
            {[...groups].map(([fileId, group]) => {
              const collapsed = batch.collapsedFiles.includes(fileId), summary = page.fileMatches?.find(file => file.id === fileId);
              return <div key={fileId} className="session-search-file" role="treeitem" aria-selected={false} aria-level={2} aria-expanded={!collapsed}>
                <div className="session-search-file-heading"><button type="button" className="session-search-disclosure" aria-label={(collapsed ? '展开' : '折叠') + group.name} aria-expanded={!collapsed} onClick={() => updateBatch(batch.id, value => ({ ...value, collapsedFiles: collapsed ? value.collapsedFiles.filter(id => id !== fileId) : [...value.collapsedFiles, fileId] }))}>{collapsed ? '▸' : '▾'}</button><button type="button" className="session-search-file-name" title={group.name} onClick={() => updateBatch(batch.id, value => ({ ...value, collapsedFiles: collapsed ? value.collapsedFiles.filter(id => id !== fileId) : [...value.collapsedFiles, fileId] }))}>{group.name}</button><span className="muted">{summary ? `${summary.hits ?? summary.count} 次，${summary.count} 行` : '汇总未显示'} · 本页 {group.rows.length} 条</span><button type="button" disabled={busy || copyBusy} onClick={() => void copyRows(batch, fileId)}>复制文件结果</button></div>
                {!collapsed && <div role="group">{group.rows.map(({ row, index }) => {
                  const current = selected?.batchId === batch.id && selected.offset === batch.offset && selected.index === index;
                  return <div key={rowKey(batch, index)} className={'session-search-hit' + (current ? ' selected' : '')} role="treeitem" aria-level={3} aria-selected={current} tabIndex={-1} data-result-key={rowKey(batch, index)} onClick={() => { results.current?.focus({ preventScroll: true }); selectRow(batch, index); }} onDoubleClick={() => selectRow(batch, index, true)} title="单击选择，双击或 Enter 打开原文"><span className="session-search-line-number">行 {row.sourceLine}{row.column ? `:${row.column}` : ''}：</span><code>{highlighted(row)}{row.messageTruncated && <small className="session-search-truncated"> …［原行已截断，打开原文］</small>}{row.rangeTruncated && <small className="session-search-truncated">［部分命中高亮已省略］</small>}</code></div>;
                })}</div>}
              </div>;
            })}
            {page && <div className="session-search-pagination"><span>{batch.offset + (page.entries.length ? 1 : 0)}–{batch.offset + page.entries.length} / {resultCount(page)} 条结果</span><button type="button" disabled={busy || copyBusy || !batch.offset} onClick={() => void loadPage(batch.id, batch.criteria, 0, { previous: [] })}>首页</button><button type="button" disabled={busy || copyBusy || !batch.offset} onClick={() => { const previous = batch.previous.length ? batch.previous.at(-1) : Math.max(0, batch.offset - PAGE_SIZE); void loadPage(batch.id, batch.criteria, previous, { previous: batch.previous.filter(value => value < previous) }); }}>上一页</button><button type="button" disabled={busy || copyBusy || page.nextOffset === null || page.nextOffset === undefined} onClick={() => void loadPage(batch.id, batch.criteria, page.nextOffset)}>下一页</button></div>}
          </div>}
        </div>;
      })}
    </div>
    <div className="session-search-footer muted"><span>最多保留 {MAX_BATCHES} 批结果 · 每页最多 {PAGE_SIZE} 条 / 1 MiB</span><span>F7 结果 · F4 / Shift+F4 前后跳转 · Enter 打开原文</span></div>
  </section>;
}
