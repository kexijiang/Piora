import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

async function loadModule() {
  const sourcePath = new URL("./session-project-groups.ts", import.meta.url);
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(sourcePath, "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('import type { SessionInfo } from "./types";\n', "");
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const {
  buildSessionProjectGroups,
  buildSessionTree,
  getProjectLabel,
  getVisibleSessionRoots,
  sessionTreeContainsAnyId,
} = await loadModule();

test("builds and searches a 12,000-level branch chain without recursion", () => {
  const sessions = Array.from({ length: 12_000 }, (_, index) => session({ id: `deep-${index}`, ...(index ? { parentSessionId: `deep-${index - 1}` } : {}) }));
  const roots = buildSessionTree(sessions.toReversed());
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "deep-0");
  assert.equal(sessionTreeContainsAnyId(roots[0], new Set(["deep-11999"])), true);
  assert.equal(sessionTreeContainsAnyId(roots[0], new Set(["missing"])), false);
  let node = roots[0];
  for (let index = 1; index < 12_000; index++) { assert.equal(node.children.length, 1); node = node.children[0]; }
  assert.equal(node.children.length, 0);
});

function session(overrides) {
  return {
    path: `/sessions/${overrides.id}.jsonl`,
    id: overrides.id,
    cwd: overrides.cwd ?? "/repo",
    projectRoot: overrides.projectRoot,
    created: overrides.modified ?? "2026-01-01T00:00:00.000Z",
    modified: overrides.modified ?? "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: overrides.id,
    parentSessionId: overrides.parentSessionId,
  };
}

test("groups worktrees by project root and sorts projects by latest activity", () => {
  const groups = buildSessionProjectGroups([
    session({ id: "a", cwd: "/repo-worktrees/a", projectRoot: "/repo", modified: "2026-01-02T00:00:00Z" }),
    session({ id: "b", cwd: "/repo", projectRoot: "/repo", modified: "2026-01-03T00:00:00Z" }),
    session({ id: "c", cwd: "/other", modified: "2026-01-04T00:00:00Z" }),
  ]);

  assert.deepEqual(groups.map((group) => group.projectRoot), ["/other", "/repo"]);
  assert.deepEqual(groups[1].sessions.map((item) => item.id), ["b", "a"]);
  assert.equal(groups[1].preferredCwd, "/repo");
});

test("adds the selected empty cwd as an active project", () => {
  const groups = buildSessionProjectGroups(
    [session({ id: "existing", cwd: "/older", modified: "2026-01-04T00:00:00Z" })],
    { cwd: "/empty" },
  );

  assert.equal(groups[0].projectRoot, "/empty");
  assert.equal(groups[0].preferredCwd, "/empty");
  assert.equal(groups[0].sessions.length, 0);
});

test("keeps explicitly added projects even when they have no sessions", () => {
  const groups = buildSessionProjectGroups(
    [session({ id: "existing", cwd: "/older", modified: "2026-01-04T00:00:00Z" })],
    null,
    [{ cwd: "/empty" }],
  );

  const empty = groups.find((group) => group.projectRoot === "/empty");
  assert.ok(empty);
  assert.equal(empty.preferredCwd, "/empty");
  assert.equal(empty.sessions.length, 0);
});

test("builds fork trees and sorts each level by latest activity", () => {
  const roots = buildSessionTree([
    session({ id: "old", modified: "2026-01-01T00:00:00Z" }),
    session({ id: "new", modified: "2026-01-03T00:00:00Z" }),
    session({ id: "child", parentSessionId: "old", modified: "2026-01-04T00:00:00Z" }),
  ]);

  assert.deepEqual(roots.map((node) => node.session.id), ["old", "new"]);
  assert.deepEqual(roots[0].children.map((node) => node.session.id), ["child"]);
});

test("turns malformed parent cycles into independent root conversations", () => {
  const roots = buildSessionTree([
    session({ id: "cycle-a", parentSessionId: "cycle-b" }),
    session({ id: "cycle-b", parentSessionId: "cycle-a" }),
  ]);

  assert.deepEqual(new Set(roots.map((node) => node.session.id)), new Set(["cycle-a", "cycle-b"]));
  assert.ok(roots.every((node) => node.children.length === 0));
});

test("shows three roots by default and appends hidden attention chains", () => {
  const roots = buildSessionTree([
    session({ id: "one", modified: "2026-01-05T00:00:00Z" }),
    session({ id: "two", modified: "2026-01-04T00:00:00Z" }),
    session({ id: "three", modified: "2026-01-03T00:00:00Z" }),
    session({ id: "hidden", modified: "2026-01-02T00:00:00Z" }),
    session({ id: "hidden-child", parentSessionId: "hidden", modified: "2026-01-01T00:00:00Z" }),
    session({ id: "last", modified: "2025-12-31T00:00:00Z" }),
  ]);

  assert.deepEqual(getVisibleSessionRoots(roots, false, new Set()).map((node) => node.session.id), ["one", "two", "three"]);
  assert.deepEqual(
    getVisibleSessionRoots(roots, false, new Set(["hidden-child"])).map((node) => node.session.id),
    ["one", "two", "three", "hidden"],
  );
  assert.equal(getVisibleSessionRoots(roots, true, new Set()).length, 5);
});

test("derives compact labels from Windows and POSIX paths", () => {
  assert.equal(getProjectLabel("C:\\work\\Piora\\"), "Piora");
  assert.equal(getProjectLabel("/work/Piora/"), "Piora");
});
