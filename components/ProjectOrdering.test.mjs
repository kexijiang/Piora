import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyProjectOrder, moveProjectRoot, reconcileProjectOrder, saveStoredStringList, loadStoredStringList, PROJECT_ORDER_STORAGE_KEY } = await jiti.import("./sidebar/sidebar-utils.ts");
const { buildSessionProjectGroups } = await jiti.import("../lib/session-project-groups.ts");
const [sidebar, area, projectList, styles] = await Promise.all([
  readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/SidebarProjectArea.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sidebar/ProjectList.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SessionSidebar.module.css", import.meta.url), "utf8"),
]);

test("applies persisted project order and appends newly discovered projects", () => {
  const projects = [{ root: "new" }, { root: "b" }, { root: "a" }];
  assert.deepEqual(
    applyProjectOrder(projects, ["a", "b"], (project) => project.root).map((project) => project.root),
    ["a", "b", "new"],
  );
});

test("moves a project before or after the hovered project", () => {
  assert.deepEqual(moveProjectRoot(["a", "b", "c"], "a", "c", "before"), ["b", "a", "c"]);
  assert.deepEqual(moveProjectRoot(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  assert.deepEqual(moveProjectRoot(["a", "b"], "missing", "b", "after"), ["a", "b"]);
});

test("keeps first-seen project positions while multiple sessions update", () => {
  const sessions = [
    { id: "a1", cwd: "/a", modified: "2026-10-30T01:00:00Z" },
    { id: "a2", cwd: "/a", modified: "2026-10-30T02:00:00Z" },
    { id: "b1", cwd: "/b", modified: "2026-10-30T03:00:00Z" },
    { id: "b2", cwd: "/b", modified: "2026-10-30T04:00:00Z" },
  ];
  const getRoot = (group) => group.projectRoot;
  const order = reconcileProjectOrder([], buildSessionProjectGroups(sessions).map(getRoot));
  assert.deepEqual(order, ["/b", "/a"]);
  for (const [index, id] of ["a1", "b1", "a2", "b2"].entries()) {
    sessions.find((session) => session.id === id).modified = `2026-10-30T0${index + 5}:00:00Z`;
    const groups = buildSessionProjectGroups(sessions);
    assert.deepEqual(applyProjectOrder(groups, order, getRoot).map(getRoot), ["/b", "/a"]);
    assert.equal(reconcileProjectOrder(order, groups.map(getRoot)), order);
  }
  assert.match(sidebar, /setProjectOrder\(\(previous\) => reconcileProjectOrder\(previous, projectGroups\.map/);
});

test("appends new projects once and prunes removed projects without moving remaining rows", () => {
  const order = reconcileProjectOrder(["b", "a", "removed"], ["new", "a", "b"]);
  assert.deepEqual(order, ["b", "a", "new"]);
  assert.equal(reconcileProjectOrder(order, ["new", "b", "a"]), order);
  assert.deepEqual(reconcileProjectOrder(order, []), []);
});

test("restores manual project order after reload despite newer activity elsewhere", (t) => {
  const storage = new Map();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    setItem: (key, value) => storage.set(key, value),
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
  } } });
  const order = reconcileProjectOrder([], ["a", "b", "c"]);
  const dragged = moveProjectRoot(order, "c", "a", "before");
  saveStoredStringList(PROJECT_ORDER_STORAGE_KEY, dragged);
  const restored = loadStoredStringList(PROJECT_ORDER_STORAGE_KEY);
  assert.deepEqual(reconcileProjectOrder(restored, ["b", "a", "c", "new"]), ["c", "a", "b", "new"]);
});

test("starts project dragging on pointer down and commits only moved pointer releases", () => {
  const beginDrag = area.slice(area.indexOf("const beginProjectDrag"), area.indexOf("const suppressProjectClick"));
  assert.match(beginDrag, /event\.button !== 0/);
  assert.match(beginDrag, /moved: false/);
  assert.match(beginDrag, /dragRef\.current = next;\s*setDragState\(next\)/);
  assert.match(area, /isDragging=\{dragState\?\.sourceRoot === group\.projectRoot\}/);
  assert.match(styles, /\.projectGroupDragging \.projectMain\s*\{\s*cursor: grabbing/);
  assert.doesNotMatch(beginDrag, /setTimeout|HOLD_MS/);
  assert.match(area, /if \(activeDrag && candidate\.moved\)/);
  assert.match(area, /if \(event\.type === "pointerup" && activeDrag\.targetRoot\)/);
  assert.match(area, /window\.addEventListener\("pointermove"/);
  assert.match(area, /onReorderProjects\(activeDrag\.sourceRoot, activeDrag\.targetRoot, activeDrag\.position\)/);
  assert.match(sidebar, /PROJECT_ORDER_STORAGE_KEY|projectOrder/);
  assert.match(projectList, /data-project-drag-handle/);
  assert.match(projectList, /data-project-drag-ignore/);
  assert.doesNotMatch(projectList, /drag handle|dragHandle|name="drag"/i);
  assert.match(styles, /\.projectDropBefore::before/);
  assert.match(styles, /\.projectDropAfter::after/);
});

test("one project click both selects the project and toggles its folder", () => {
  assert.match(projectList, /onClick=\{\(\) => \{ onSelectProject\(\); onToggleProject\(\); \}\}/);
  assert.doesNotMatch(projectList, /if \(isSelectedProject\) onToggleProject/);
});
