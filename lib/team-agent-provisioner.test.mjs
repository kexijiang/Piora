import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveProvisionableTeamAgentProfile } = await jiti.import("./team-agent-provisioner.ts");
const { configureTeamAgentTools } = await jiti.import("./team-agent-tools.ts");
const { createRoomChatProfile, createTeamAgentProfile } = await jiti.import("./team-agent-templates.ts");

test("chat member defaults do not provision worktrees or impose predefined jobs", () => {
  for (const role of ["coordinator", "planner", "worker", "reviewer", "participant"]) {
    const profile = createRoomChatProfile({ role, name: "自定义成员", roleDescription: undefined });
    assert.equal(profile.workspacePolicy.mode, "shared");
    assert.equal(profile.roleDescription, "");
    assert.equal(profile.systemPrompt, "");
    assert.equal(profile.toolPolicy.mode, "inherit");
  }
});

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Piora tests",
      GIT_AUTHOR_EMAIL: "tests@example.invalid",
      GIT_COMMITTER_NAME: "Piora tests",
      GIT_COMMITTER_EMAIL: "tests@example.invalid",
    },
  });
}

function room(projectRoot) {
  return {
    projectRoot,
    members: [],
    coordination: { coordinatorMemberId: "missing" },
    workspace: { path: projectRoot },
  };
}

test("managed coordinator and worker retain inherited tools and enable group collaboration", async () => {
  for (const role of ["coordinator", "worker"]) {
    let command;
    await configureTeamAgentTools({ inner: { getActiveToolNames: () => ["read", "write", "bash"] }, async send(value) { command = value; } }, createTeamAgentProfile(role));
    assert.deepEqual(command.toolNames, ["read", "write", "bash", "piora_room"]);
  }
  let command;
  await configureTeamAgentTools({ inner: { getActiveToolNames: () => ["write"] }, async send(value) { command = value; } }, createTeamAgentProfile("reviewer"));
  assert.ok(command.toolNames.includes("piora_room"));
  assert.ok(!command.toolNames.includes("write"));
});

test("managed agents fall back to a shared workspace when Git HEAD is unborn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-team-unborn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");

  const requested = createTeamAgentProfile("worker");
  assert.equal(requested.workspacePolicy.mode, "dedicated_worktree");
  const resolved = await resolveProvisionableTeamAgentProfile(room(root), requested);
  assert.equal(resolved.workspacePolicy.mode, "shared");
  assert.equal(resolved.workspacePolicy.integration, "artifact_only");
});

test("managed agents keep dedicated worktrees when the repository has a commit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-team-committed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");
  writeFileSync(join(root, "README.md"), "committed\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");

  const requested = createTeamAgentProfile("reviewer");
  const resolved = await resolveProvisionableTeamAgentProfile(room(root), requested);
  assert.equal(resolved.workspacePolicy.mode, "dedicated_worktree");
});

test("managed agents also fall back for ordinary non-Git folders", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-team-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolved = await resolveProvisionableTeamAgentProfile(
    room(root),
    createTeamAgentProfile("worker"),
  );
  assert.equal(resolved.workspacePolicy.mode, "shared");
});
