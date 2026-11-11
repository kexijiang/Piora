// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import React, { useEffect, useRef, useState } from 'react';
import { libraryRequest } from '@/lib/harmony/log-library/vendor/log-client.mjs';
export function LogApplicationFilter({ applications = [], value, onChange, sessionId }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [favorites, setFavorites] = useState([]), [error, setError] = useState(''), [cursor, setCursor] = useState(0);
  const root = useRef(), input = useRef();
  useEffect(() => {
    if (!sessionId) return; let active = true;
    const load = () => libraryRequest(sessionId, 'preferences').then(v => { if (active) setFavorites(v.favorites || []); }).catch(() => {});
    load(); window.addEventListener('pioraLogs:favorites', load); return () => { active = false; window.removeEventListener('pioraLogs:favorites', load); };
  }, [sessionId]);
  useEffect(() => { if (open) input.current?.focus(); const close = e => { if (!root.current?.contains(e.target)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [open]);
  useEffect(() => setCursor(0), [query]);
  const starred = new Set(favorites.map(f => f.bundle)), all = [...applications, ...favorites.filter(f => !applications.some(a => a.bundle === f.bundle)).map(f => ({ ...f, count: 0 }))];
  const term = query.trim().toLocaleLowerCase(), candidates = all.filter(a => `${a.label || ''} ${a.bundle} ${(a.pids || []).join(' ')}`.toLocaleLowerCase().includes(term)).sort((a, b) => Number(starred.has(b.bundle)) - Number(starred.has(a.bundle)) || a.bundle.localeCompare(b.bundle));
  async function toggle(app) { try { const v = await libraryRequest(sessionId, 'preferences', { body: { bundle: app.bundle, label: app.label, favorite: !starred.has(app.bundle) } }); setFavorites(v.favorites || []); window.dispatchEvent(new Event('pioraLogs:favorites')); setError(''); } catch (e) { setError(e.message); } }
  const choose = bundle => { onChange(bundle); setOpen(false); };
  return <div className="offline-app-picker" ref={root}><button aria-label="按应用包名过滤" aria-expanded={open} onClick={() => setOpen(!open)}>应用 / 包名：{value === '__unknown__' ? '归属未知' : value || '全部应用'} ▾</button>
    {open && <div className="offline-app-popup" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } if (e.target === input.current && ['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Enter' && candidates[cursor]) choose(candidates[cursor].bundle); else setCursor(i => Math.max(0, Math.min(49, candidates.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); } }}>
      <input ref={input} aria-label="搜索离线包名或PID" placeholder="搜索包名、名称或 PID" maxLength={256} value={query} onChange={e => setQuery(e.target.value)}/>
      <div className="row"><button onClick={() => choose('')}>全部应用</button><button onClick={() => choose('__unknown__')}>归属未知</button></div>
      <small className="muted">匹配 {candidates.length} 个 · ★ 收藏优先</small>
      <div className="offline-app-candidates">{candidates.slice(0, 50).map((app, i) => <div key={app.bundle} className={'offline-app-option' + (i === cursor ? ' active' : '')}><button onClick={() => choose(app.bundle)} aria-pressed={app.bundle === value}><strong>{app.label || app.bundle}</strong><small>{app.bundle} · {app.count || 0} 条</small></button><button aria-label={(starred.has(app.bundle) ? '取消收藏 ' : '收藏 ') + app.bundle} aria-pressed={starred.has(app.bundle)} onClick={() => toggle(app)}>{starred.has(app.bundle) ? '★' : '☆'}</button></div>)}{candidates.length > 50 && <small>请输入更多关键词缩小范围</small>}{!candidates.length && <p>没有匹配的包名</p>}</div>{error && <p role="alert" className="error">{error}</p>}
    </div>}
  </div>;
}
