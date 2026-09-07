"use client";

import { useRef, useState } from "react";
import { createCompanionId, MAX_COMPANION_TODOS, type CompanionTodo } from "@/lib/companion-store";
import { AliIcon } from "./AliIcon";
import styles from "./CompanionTodoList.module.css";

export function CompanionTodoList({ todos, busy, onChange }: {
  todos: CompanionTodo[]; busy: boolean;
  onChange: (update: (current: CompanionTodo[]) => CompanionTodo[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [reminder, setReminder] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [removed, setRemoved] = useState<{ todo: CompanionTodo; index: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = todos.filter((todo) => !todo.completed).length;
  const visible = todos.filter((todo) => (showCompleted || !todo.completed) && todo.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const add = async () => {
    const text = draft.trim();
    if (busy || !text || todos.length >= MAX_COMPANION_TODOS) return;
    const now = Date.now();
    if (await onChange((current) => [{ id: createCompanionId("todo"), text, completed: false, progress: 0, reminderEnabled: reminder, createdAt: now, updatedAt: now }, ...current])) {
      setDraft((current) => current.trim() === text ? "" : current);
      input.current?.focus();
    }
  };
  const update = (id: string, patch: Partial<CompanionTodo>) => onChange((current) => current.map((todo) => todo.id === id ? { ...todo, ...patch, updatedAt: Date.now() } : todo));
  const saveEdit = async () => {
    if (!editing || !editText.trim() || busy) return;
    if (await update(editing, { text: editText.trim() })) setEditing(null);
  };
  return <section className={styles.todos} aria-label="我的待办">
    <header className={styles.heading}><div><h1>待办</h1><p>{active} 项待办 · {todos.length - active} 项已完成</p></div><button type="button" aria-pressed={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? "隐藏已完成" : "查看已完成"}</button></header>
    <form className={styles.capture} onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <input ref={input} aria-label="新待办" placeholder="添加一个待办任务" maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); }} />
      <button className={styles.reminder} type="button" aria-label="新待办的宠物提醒" aria-pressed={reminder} title={reminder ? "新待办会由宠物偶尔提醒" : "新待办不提醒"} onClick={() => setReminder(!reminder)}><AliIcon name="bell" size={17} /></button>
      <button className={styles.add} disabled={busy || !draft.trim() || todos.length >= MAX_COMPANION_TODOS}>添加</button>
    </form>
    <p className={styles.hint}>{todos.length >= MAX_COMPANION_TODOS ? "清单已满 100 项，移除不需要的待办后继续添加。" : "开启铃铛，宠物每隔 30–60 分钟轻声提醒一件事。专注与安静时段不打扰。"}</p>
    {todos.length > 5 || query ? <input className={styles.search} aria-label="搜索待办" placeholder="在清单中查找…" value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
    <div className={styles.list}>{visible.map((todo) => <article className={styles.row} data-done={todo.completed} key={todo.id}>
      <button className={styles.check} type="button" aria-label={`${todo.completed ? "标为未完成" : "完成"}：${todo.text}`} aria-pressed={todo.completed} disabled={busy} onClick={() => void update(todo.id, { completed: !todo.completed, progress: todo.completed ? 0 : 100 })}>{todo.completed ? "✓" : ""}</button>
      {editing === todo.id ? <form className={styles.edit} onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
        <input autoFocus aria-label="编辑待办内容" maxLength={240} value={editText} onChange={(event) => setEditText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
        <button disabled={busy || !editText.trim()}>保存</button><button type="button" onClick={() => setEditing(null)}>取消</button>
      </form> : <button className={styles.title} type="button" aria-label={`编辑：${todo.text}`} onClick={() => { setEditing(todo.id); setEditText(todo.text); }}>{todo.text}</button>}
      <div className={styles.actions}>
        {!todo.completed ? <button type="button" className={styles.reminder} aria-label={`宠物提醒：${todo.text}`} aria-pressed={Boolean(todo.reminderEnabled)} title={todo.reminderEnabled ? "关闭宠物提醒" : "开启宠物提醒"} disabled={busy} onClick={() => void update(todo.id, { reminderEnabled: !todo.reminderEnabled })}><AliIcon name="bell" size={16} /></button> : null}
        <button type="button" aria-label={`删除：${todo.text}`} title="删除待办" disabled={busy} onClick={async () => { const index = todos.findIndex((item) => item.id === todo.id); if (await onChange((current) => current.filter((item) => item.id !== todo.id))) { setRemoved({ todo, index }); if (editing === todo.id) setEditing(null); } }}><AliIcon name="delete" size={16} /></button>
      </div>
    </article>)}</div>
    {!visible.length ? <div className={styles.empty}><AliIcon name="check-circle" size={32} /><b>{query ? "没有匹配的待办" : active === 0 && todos.length ? "这一页的小事，都完成了" : "给下一件事留个位置"}</b><span>{query ? "换个词试试。" : "记下来，腾出心思做眼前的事。"}</span></div> : null}
    <footer className={styles.feedback} role="status">{removed ? <><span>已删除“{removed.todo.text}”</span><button type="button" disabled={busy || todos.length >= MAX_COMPANION_TODOS} onClick={async () => { if (await onChange((current) => { if (current.some((todo) => todo.id === removed.todo.id)) return current; const next = [...current]; next.splice(Math.min(removed.index, next.length), 0, removed.todo); return next; })) setRemoved(null); }}>撤销</button></> : <span>输入后按 Enter 添加 · 点击内容编辑</span>}</footer>
  </section>;
}
