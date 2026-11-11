// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import React, { useEffect, useRef, useState } from 'react';
import { compilePattern } from '@/lib/harmony/log-library/vendor/log-query.mjs';

/**
 * Shared search history for the log views.
 *
 * The store is served by dshHarmony (`/api/harmony/logs/search-history`); this
 * module only reads and writes it, and degrades to "unavailable" when that
 * endpoint is missing (for example a dshE2E-only installation). Nothing is kept
 * in browser storage, so the desktop and web profiles share one list.
 *
 * Plain functions instead of `useCallback`: the React seam used by the
 * headless client tests only provides the hooks the viewer actually needs.
 */
export const SEARCH_HISTORY_URL = '/api/harmony/logs/search-history';

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    const error = new Error(message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function useLogSearchHistory(kind) {
  const [entries, setEntries] = useState([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const apply = history => {
    if (!mounted.current) return;
    const list = Array.isArray(history?.[kind]) ? history[kind] : [];
    setEntries(list.slice(0, 30));
  };
  const unavailable = cause => cause?.status === 404 || cause?.status === 501;

  async function reload(signal) {
    try {
      apply((await readJson(await fetch(SEARCH_HISTORY_URL, { cache: 'no-store', signal }))).history);
      if (mounted.current) { setAvailable(true); setError(''); }
    } catch (cause) {
      if (signal?.aborted || !mounted.current) return;
      if (unavailable(cause)) { setAvailable(false); setEntries([]); return; }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function mutate(body) {
    try {
      const response = await fetch(SEARCH_HISTORY_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ...body }),
      });
      apply((await readJson(response)).history);
      if (mounted.current) setError('');
    } catch (cause) {
      if (!mounted.current) return;
      if (unavailable(cause)) { setAvailable(false); return; }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function record(query, regex, caseSensitive) {
    if (!available) return;
    const text = String(query ?? '').trim();
    if (!text) return;
    // Reuse the viewer's own bounded dialect: a pattern it would reject must not
    // be stored and replayed later.
    try { compilePattern(text, { regex: Boolean(regex), caseSensitive: Boolean(caseSensitive) }); }
    catch { return; }
    void mutate({ action: 'record', query: text, regex: Boolean(regex), caseSensitive: Boolean(caseSensitive) });
  }

  const remove = entry => { void mutate({ action: 'remove', query: entry.query, regex: entry.regex, caseSensitive: entry.caseSensitive }); };
  const clear = () => { void mutate({ action: 'clear' }); };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
    // One read at mount; the list is re-read explicitly when a menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { entries, available, error, reload, record, remove, clear };
}

/** Shared presentation for both search boxes; visibility is the caller's job. */
export function LogSearchHistoryMenu({ entries, cursor, onCursor, onPick, onRemove, onClear, onClose, label }) {
  const list = useRef();
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  return <div className="log-search-history" role="group" aria-label={label || '搜索历史'} onMouseDown={event => event.preventDefault()}>
    <div className="row spread"><strong>最近使用</strong><span className="muted">{entries.length}/30</span><button onClick={onClear} disabled={!entries.length}>清空</button><button aria-label="关闭历史" onClick={onClose}>×</button></div>
    {entries.length ? <ul ref={list} role="listbox" aria-label="搜索历史条目">
      {entries.map((entry, index) => <li key={`${entry.regex ? 're' : 'lit'}:${entry.caseSensitive ? 'cs' : 'ci'}:${entry.query}`} role="option" aria-selected={index === cursor}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => onCursor(index)} onClick={() => onPick(entry)}>
        <span>{entry.query}</span><small className="muted">{entry.regex ? '正则' : '文本'}{entry.caseSensitive ? ' · 区分大小写' : ''}</small>
        <button aria-label={`删除 ${entry.query}`} onClick={event => { event.stopPropagation(); onRemove(entry); }}>×</button>
      </li>)}
    </ul> : <p className="muted">还没有历史记录。执行一次查找或筛选后会出现。</p>}
  </div>;
}
