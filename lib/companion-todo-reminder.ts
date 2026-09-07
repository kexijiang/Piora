import type { CompanionDecision, CompanionRuntimeState } from "./companion-runtime";
import type { CompanionTodo } from "./companion-store";

export const TODO_REMINDER_MIN_MS = 30 * 60_000;
export function nextTodoReminderAt(now: number, random = Math.random): number {
  return now + TODO_REMINDER_MIN_MS + Math.floor(Math.max(0, Math.min(1, random())) * TODO_REMINDER_MIN_MS);
}

// The server owns the schedule. Unrelated saves must not overwrite a newer wake time.
export function scheduleTodoReminders(todos: CompanionTodo[], current: CompanionTodo[], now = Date.now(), random = Math.random): CompanionTodo[] {
  return todos.map((todo) => {
    const previous = current.find((item) => item.id === todo.id);
    const rest = { ...todo };
    delete rest.nextReminderAt;
    if (todo.completed || !todo.reminderEnabled) return rest;
    return { ...rest, nextReminderAt: previous?.reminderEnabled && !previous.completed && previous.nextReminderAt
      ? previous.nextReminderAt : nextTodoReminderAt(now, random) };
  });
}

export function remindDueTodo(state: CompanionRuntimeState, now = Date.now(), random = Math.random, createId = () => crypto.randomUUID()): CompanionRuntimeState | null {
  const { settings } = state;
  if (settings.autonomyPaused || !settings.allowProactiveSpeech || state.focusTimer.status === "running") return null;
  const quiet = settings.quietHours;
  if (quiet.enabled) {
    const date = new Date(now);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (quiet.start === quiet.end || (quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end)) return null;
  }
  // Many overdue tasks after sleep still produce one gentle reminder, not a burst.
  if (state.mind.decisionHistory.some((item) => item.event === "todo.reminder" && now - item.createdAt < TODO_REMINDER_MIN_MS)) return null;
  if (state.mind.lastDecision && now - state.mind.lastDecision.createdAt < 60_000) return null;
  const todo = state.todos.filter((item) => !item.completed && item.reminderEnabled && item.nextReminderAt !== undefined && item.nextReminderAt <= now)
    .sort((a, b) => a.nextReminderAt! - b.nextReminderAt!)[0];
  if (!todo) return null;
  const decision: CompanionDecision = {
    id: `decision:${createId()}`, event: "todo.reminder", mood: "calm",
    thoughtSummary: "轻轻提醒一件还没完成的小事。", speech: `还记得“${todo.text.slice(0, 60)}”吗？有空时可以做一下。`,
    actions: [{ kind: "speak" }, { kind: "animate", animation: "waving" }],
    observedFacts: [`未完成待办：${todo.text}`], nextThinkAfterSeconds: 300, createdAt: now,
  };
  return { ...state,
    todos: state.todos.map((item) => item.id === todo.id ? { ...item, nextReminderAt: nextTodoReminderAt(now, random) } : item),
    mind: { ...state.mind, lastDecision: decision, mood: decision.mood, nextWakeAt: now + 300_000, decisionHistory: [decision, ...state.mind.decisionHistory].slice(0, 80) },
  };
}
