import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applySessionOrder, moveSessionId } = await jiti.import("./sidebar/sidebar-utils.ts");
const [sidebar, list, projectArea, projectList, chatArea, styles] = await Promise.all([
  readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/TaskList.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/SidebarProjectArea.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/ProjectList.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/SidebarChatArea.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SessionSidebar.module.css", import.meta.url), "utf8"),
]);

test("applies persisted session order and appends new sessions", () => {
  const sessions = [{ id: "new" }, { id: "b" }, { id: "a" }];
  assert.deepEqual(
    applySessionOrder(sessions, ["a", "b"], (session) => session.id).map((session) => session.id),
    ["a", "b", "new"],
  );
});

test("moves a session before or after another session", () => {
  assert.deepEqual(moveSessionId(["a", "b", "c"], "a", "c", "before"), ["b", "a", "c"]);
  assert.deepEqual(moveSessionId(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  assert.deepEqual(moveSessionId(["a", "b"], "missing", "b", "after"), ["a", "b"]);
});

test("keeps pinned sessions ahead while applying manual order within each section", () => {
  const sessions = [{ id: "regular" }, { id: "pinned-b", pinned: true }, { id: "pinned-a", pinned: true }];
  assert.deepEqual(
    applySessionOrder(sessions, ["pinned-a", "regular", "pinned-b"], (session) => session.id, (session) => session.pinned === true)
      .map((session) => session.id),
    ["pinned-a", "pinned-b", "regular"],
  );
});

test("long-presses every session row with the left pointer and persists the order", () => {
  assert.match(list, /SESSION_DRAG_HOLD_MS = 250/);
  assert.match(list, /event\.button !== 0/);
  assert.match(list, /setPointerCapture\(event\.pointerId\)/);
  assert.doesNotMatch(list, /window\.addEventListener\("pointermove"/);
  assert.match(list, /data-session-drag-id/);
  assert.match(list, /targetScope !== activeDrag\.sourceScope/);
  assert.match(list, /onReorderSessions\(activeDrag\.sourceId, activeDrag\.targetId, activeDrag\.position\)/);
  assert.match(sidebar, /sessionOrder, setSessionOrder/);
  assert.match(projectArea, /data-session-drag-scroll/);
  assert.match(projectList, /getVisibleSessionRoots\(orderedRoots/);
  assert.match(chatArea, /data-session-drag-scroll/);
  assert.match(styles, /\.sessionDropBefore::before/);
  assert.match(styles, /\.sessionDropAfter::after/);
});

test("keeps a short left press as ordinary session selection", () => {
  assert.match(list, /else if \(event\.type === "pointerup"\)/);
  assert.match(list, /onSelectSession\(candidate\.session\)/);
  assert.match(list, /suppressClickRef\.current = \{ sessionId: candidate\.session\.id/);
  assert.match(list, /event\.type === "pointerup"[\s\S]*?onSelectSession[\s\S]*?stopDragging\(\)/);
  assert.doesNotMatch(list, /event\.type === "pointercancel"[\s\S]*?onSelectSession/);
});

test("keeps branch and project ownership intact by accepting drops only among siblings", () => {
  assert.match(list, /scope=\{scope \+ ":" \+ \(row\.parentId \?\? "root"\)/);
  assert.match(list, /pinned \? "pinned" : "regular"/);
  assert.match(list, /targetScope !== activeDrag\.sourceScope/);
  assert.doesNotMatch(list, /parentSessionId\s*=/);
});
