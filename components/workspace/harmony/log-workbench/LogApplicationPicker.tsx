// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LogSessionContext } from './log-session';
import { logApplicationPids, logProcessMatches } from '@/lib/harmony/log-application';
import styles from './RealtimeLogs.module.css';
type App = { bundleName: string; label?: string; process?: string };
export function LogApplicationPicker({ applications, processes, value, onChange, copy }: { applications: App[]; processes: { pid: number; name: string }[]; value: string; onChange: (bundle: string) => void; copy: (zh: string, en: string) => string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [cursor, setCursor] = useState(0), [scroll, setScroll] = useState(0);
  const { sessionId } = useContext(LogSessionContext);
  const [favorites, setFavorites] = useState<{bundle: string; label?: string}[]>([]), [favoriteError, setFavoriteError] = useState('');
  useEffect(() => {
    if (!sessionId) return; let alive = true;
    const load = () => fetch('/api/harmony/log-library/preferences?' + new URLSearchParams({ sessionId })).then(r => r.json()).then(v => { if (alive && !v.error) setFavorites(v.favorites || []); }).catch(() => {});
    load(); window.addEventListener('pioraLogs:favorites', load); return () => { alive = false; window.removeEventListener('pioraLogs:favorites', load); };
  }, [sessionId]);
  const starred = new Set(favorites.map(item => item.bundle));
  async function toggleFavorite(app: App) {
    if (!sessionId) return;
    try { const response = await fetch('/api/harmony/log-library/preferences?' + new URLSearchParams({ sessionId }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle: app.bundleName, label: app.label, favorite: !starred.has(app.bundleName) }) }); const value = await response.json(); if (!response.ok || value.error) throw Error(value.error || '收藏暂时不可用，请重试'); setFavorites(value.favorites || []); setFavoriteError(''); window.dispatchEvent(new Event('pioraLogs:favorites')); }
    catch (error) { setFavoriteError(error instanceof Error ? error.message : String(error)); }
  }
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), id = useId();
  const candidates = useMemo(() => {
    const term = query.trim().toLocaleLowerCase(), running = term ? processes.filter(p => `${p.name} ${p.pid}`.toLocaleLowerCase().includes(term)) : [];
    return applications.filter(app => !term || `${app.label || ''} ${app.bundleName} ${app.process || ''}`.toLocaleLowerCase().includes(term) || running.some(p => [app.bundleName, app.process].some(name => name && logProcessMatches(p.name, name)))).sort((a, b) => Number(starred.has(b.bundleName)) - Number(starred.has(a.bundleName)));
  }, [query, applications, processes, favorites]);
  const selected = applications.find(app => app.bundleName === value);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { setCursor(0); setScroll(0); if (list.current) list.current.scrollTop = 0; }, [query]);
  useEffect(() => { setCursor(index => Math.min(index, Math.max(0, candidates.length - 1))); }, [candidates.length]);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [open]);
  const choose = (bundle: string) => { onChange(bundle); setOpen(false); trigger.current?.focus(); };
  const first = Math.max(0, Math.floor(scroll / 56) - 2), last = Math.min(candidates.length, first + 12);
  return <div ref={root} className={styles.logAppPicker}>
    <button ref={trigger} type="button" aria-label={copy('按应用包名过滤', 'Filter by application bundle')} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>{value ? `${selected?.label ? selected.label + ' · ' : ''}${value}` : copy('全部应用和系统进程', 'All apps and system processes')} <span>▾</span></button>
    {open && <div className={styles.logAppPopup} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
      if (event.target !== input.current) { if (event.key === 'Enter') event.stopPropagation(); return; }
      if (['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      if (event.key === 'Enter' && candidates[cursor]) choose(candidates[cursor].bundleName);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const next = Math.max(0, Math.min(candidates.length - 1, cursor + (event.key === 'ArrowDown' ? 1 : -1))); setCursor(next); if (list.current) { list.current.scrollTop = Math.max(0, next * 56 - 112); setScroll(list.current.scrollTop); } }
    }}>
      <div className={styles.logAppSearch}><input ref={input} role="combobox" aria-label={copy('搜索应用、包名或 PID', 'Search application, bundle or PID')} aria-expanded="true" aria-controls={id} aria-activedescendant={candidates[cursor] ? `${id}-${cursor}` : undefined} placeholder={copy('搜索名称、包名、进程或 PID', 'Name, bundle, process or PID')} maxLength={256} value={query} onChange={e => setQuery(e.target.value)}/><button aria-label={copy('清空应用搜索', 'Clear app search')} onClick={() => setQuery('')}>×</button></div>
      <div className={styles.logAppCount}>{copy(`匹配 ${candidates.length} 个应用 · ★ 收藏优先`, `${candidates.length} applications · favorites first`)}</div>
      <div ref={list} id={id} role="listbox" className={styles.logAppCandidates} onScroll={e => setScroll(e.currentTarget.scrollTop)}>
        {candidates.length ? <div style={{ height: candidates.length * 56, position: 'relative' }}>{candidates.slice(first, last).map((app, i) => { const index = first + i, pids = [...logApplicationPids(processes, app.bundleName, app.process)]; return <div key={app.bundleName} style={{ position: 'absolute', top: index * 56, left: 0, right: 0, height: 56 }}><button id={`${id}-${index}`} role="option" aria-selected={app.bundleName === value} data-active={index === cursor} className={styles.logAppOption} style={{ top: 0, width: '100%', paddingRight: 42 }} onMouseEnter={() => setCursor(index)} onClick={() => choose(app.bundleName)}><strong>{app.label || app.bundleName}</strong><small>{app.bundleName}</small><span>{pids.length ? 'PID ' + pids.join(', ') : copy('未运行', 'Not running')}</span></button><button type="button" aria-label={(starred.has(app.bundleName) ? '取消收藏 ' : '收藏 ') + app.bundleName} aria-pressed={starred.has(app.bundleName)} disabled={!sessionId} style={{ position: 'absolute', right: 6, top: 10, zIndex: 1 }} onClick={() => void toggleFavorite(app)}>{starred.has(app.bundleName) ? '★' : '☆'}</button></div>; })}</div> : <div className={styles.logEmpty}>{copy('没有匹配的应用', 'No matching applications')}</div>}
      </div>
      {favoriteError && <small role="alert">{favoriteError}</small>}
      <button className={styles.logAppAll} onClick={() => choose('')}>{copy('全部应用和系统进程', 'All apps and system processes')}</button>
    </div>}
  </div>;
}
