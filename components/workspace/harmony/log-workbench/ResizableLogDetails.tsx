// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './RealtimeLogs.module.css';
const preference = 'piora:log-details:v1';
export function ResizableLogDetails({ children, tools, copy }: { children: ReactNode; tools: ReactNode; copy: (zh: string, en: string) => string }) {
  const [ratio, setRatio] = useState(() => { try { const value = Number(localStorage.getItem(preference)); return value >= .15 && value <= .85 ? value : .32; } catch { return .32; } });
  const [space, setSpace] = useState(300), [maximized, setMaximized] = useState(false), [collapsed, setCollapsed] = useState(false), [wrap, setWrap] = useState(() => { try { return localStorage.getItem(preference + ':wrap') !== 'false'; } catch { return true; } });
  const pane = useRef<HTMLDivElement>(null), dragging = useRef<{ startY: number; startHeight: number; area: number } | undefined>(undefined), frame = useRef<number | undefined>(undefined), pending = useRef(ratio);
  useEffect(() => { try { localStorage.setItem(preference, String(ratio)); } catch {} }, [ratio]);
  useEffect(() => { try { localStorage.setItem(preference + ':wrap', String(wrap)); } catch {} }, [wrap]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  const measure = () => { const parent = pane.current?.parentElement; if (!parent) return; const fixed = Array.from(parent.children).filter(child => child !== pane.current && child.getAttribute('role') !== 'log').reduce((sum, child) => sum + child.getBoundingClientRect().height, 0); setSpace(Math.max(80, parent.clientHeight - fixed)); };
  useLayoutEffect(measure);
  useEffect(() => { const parent = pane.current?.parentElement; if (!parent) return; const observer = new ResizeObserver(measure); observer.observe(parent); return () => observer.disconnect(); }, []);
  const constrain = (value: number) => Math.max(.15, Math.min(.85, value));
  return <div ref={pane} className={styles.logDetails} style={{ flexBasis: collapsed ? 42 : Math.max(42, Math.min(space - 60, (maximized ? .85 : ratio) * space)) }} data-wrap={wrap}>
    <div role="separator" aria-label={copy('调整日志详情高度', 'Resize log details')} aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(ratio * 100)} tabIndex={0} className={styles.logDetailResize}
      onPointerDown={e => { if (!pane.current?.parentElement) return; dragging.current = { startY: e.clientY, startHeight: pane.current.clientHeight, area: space }; e.currentTarget.setPointerCapture(e.pointerId); setCollapsed(false); setMaximized(false); }}
      onPointerMove={e => { const start = dragging.current; if (!start || !e.currentTarget.hasPointerCapture(e.pointerId)) return; pending.current = constrain((start.startHeight + start.startY - e.clientY) / start.area); if (!frame.current) frame.current = requestAnimationFrame(() => { setRatio(pending.current); frame.current = undefined; }); }}
      onPointerUp={e => { dragging.current = undefined; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { dragging.current = undefined; }}
      onDoubleClick={() => { setRatio(.32); setCollapsed(false); setMaximized(false); }} onKeyDown={e => { if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setCollapsed(false); setMaximized(false); setRatio(value => constrain(value + (e.key === 'ArrowUp' ? .05 : -.05))); } }}/>
    <div className={styles.logDetailTools}>{collapsed ? <><strong>{copy('日志详情', 'Log details')}</strong><button onClick={() => setCollapsed(false)}>{copy('展开详情', 'Expand details')}</button></> : <>{tools}<button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{copy('自动换行', 'Wrap')}</button><button onClick={() => setMaximized(!maximized)}>{maximized ? copy('还原', 'Restore') : copy('最大化', 'Maximize')}</button><button onClick={() => setCollapsed(true)}>{copy('收起', 'Collapse')}</button></>}</div>
    {!collapsed && <div className={styles.logDetailContent}>{children}</div>}
  </div>;
}
