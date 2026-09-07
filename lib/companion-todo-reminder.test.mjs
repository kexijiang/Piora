import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const jiti = createJiti(import.meta.url);
const { nextTodoReminderAt, scheduleTodoReminders, remindDueTodo, TODO_REMINDER_MIN_MS } = await jiti.import("./companion-todo-reminder.ts");
const { createDefaultCompanionRuntimeState, normalizeCompanionRuntimeState } = await jiti.import("./companion-runtime.ts");
const now = new Date(2026, 8, 7, 12).getTime();
const todo = { id: "todo:test", text: "喝杯水", completed: false, progress: 0, reminderEnabled: true, nextReminderAt: now, createdAt: 1, updatedAt: 1 };
const fixture = () => ({ ...createDefaultCompanionRuntimeState(), todos: [{ ...todo }] });
test("new reminders are randomly scheduled 30–60 minutes away and persisted", () => {
  assert.equal(nextTodoReminderAt(now, () => 0), now + 30 * 60_000);
  assert.equal(nextTodoReminderAt(now, () => 1), now + 60 * 60_000);
  const todos = scheduleTodoReminders([todo], [], now, () => .5);
  assert.equal(todos[0].nextReminderAt, now + 45 * 60_000);
  assert.deepEqual(normalizeCompanionRuntimeState({ ...fixture(), todos }).todos, todos);
});
test("unrelated saves cannot rewind reminders; completed/disabled ones have no schedule", () => {
  assert.equal(scheduleTodoReminders([todo], [{ ...todo, nextReminderAt: now + 123 }], now)[0].nextReminderAt, now + 123);
  for (const change of [{ completed: true }, { reminderEnabled: false }]) assert.equal(scheduleTodoReminders([{ ...todo, ...change }], [todo], now)[0].nextReminderAt, undefined);
});
test("due reminder creates a pet bubble without a model and avoids a duplicate across windows", () => {
  const result = remindDueTodo(fixture(), now, () => .5, () => "test");
  assert.match(result.mind.lastDecision.speech, /喝杯水/);
  assert.equal(result.mind.lastDecision.event, "todo.reminder");
  assert.equal(result.todos[0].nextReminderAt, now + 45 * 60_000);
  assert.equal(remindDueTodo(result, now + 1), null);
});
test("multiple overdue tasks remain spaced out after sleep", () => {
  const state = fixture(); state.todos.push({ ...todo, id: "todo:second" });
  const result = remindDueTodo(state, now, () => 1, () => "first");
  assert.equal(remindDueTodo(result, now + TODO_REMINDER_MIN_MS - 1), null);
  assert.ok(remindDueTodo(result, now + TODO_REMINDER_MIN_MS));
});
test("completion, reminder toggle, focus, paused autonomy and quiet hours suppress reminders", () => {
  for (const change of [{ completed: true }, { reminderEnabled: false }, { nextReminderAt: now + 1 }]) {
    const state = fixture(); state.todos[0] = { ...todo, ...change }; assert.equal(remindDueTodo(state, now), null);
  }
  for (const change of [{ autonomyPaused: true }, { allowProactiveSpeech: false }, { quietHours: { enabled: true, start: "11:00", end: "13:00" } }]) {
    const state = fixture(); Object.assign(state.settings, change); assert.equal(remindDueTodo(state, now), null);
  }
  const state = fixture(); state.focusTimer.status = "running"; assert.equal(remindDueTodo(state, now), null);
});
test("quiet hours across midnight defer rather than discard a reminder", () => {
  const state = fixture(); state.settings.quietHours = { enabled: true, start: "22:30", end: "08:00" };
  const night = new Date(2026, 8, 7, 23).getTime();
  assert.equal(remindDueTodo(state, night), null);
  assert.ok(remindDueTodo(state, new Date(2026, 8, 8, 8).getTime()));
});

test("reminder API persists exactly one decision and rejects cross-origin requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-todo-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const loader = createJiti(import.meta.url, { tsconfigPaths: true });
    const runtime = await loader.import("./companion-runtime.ts");
    const { POST } = await loader.import("../app/api/companion/todos/remind/route.ts");
    const state = runtime.createDefaultCompanionRuntimeState();
    state.todos = [{ ...todo, nextReminderAt: 1 }];
    runtime.writeCompanionRuntimeState(state);
    const request = (origin = "http://localhost") => new Request("http://localhost/api/companion/todos/remind", { method: "POST", headers: { host: "localhost", origin } });
    assert.equal((await POST(request("https://untrusted.example"))).status, 403);
    assert.equal((await (await POST(request())).json()).reminded, true);
    assert.equal((await (await POST(request())).json()).reminded, false);
    const stored = runtime.readCompanionRuntimeState();
    assert.equal(stored.mind.decisionHistory.filter(item => item.event === "todo.reminder").length, 1);
    assert.ok(stored.todos[0].nextReminderAt > Date.now());
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("piora-todo-api-"));
    await rm(root, { recursive: true, force: true });
  }
});
