import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const { assessShellCommand, assessShellExecution } = await createJiti(import.meta.url).import("./shell/risk.ts");

test("ordinary development commands run automatically while destructive or publishing actions require review", () => {
  for (const command of ["git status", "git add src", "git commit -m 'fix view'", "git switch feature", "npm install", "pnpm add lodash", "npm ci", "tsc --noEmit", "vitest run", "next dev --port 30141", "Start-Sleep -Seconds 1", "Set-Location -LiteralPath 'folder with spaces'"]) {
    assert.equal(assessShellCommand(command, "powershell").confirmation, false, command);
  }
  for (const command of ["git push", "git reset --hard", "git checkout README.md", "git switch -C main", "git commit --amend", "npm publish", "npm install --global", "npm install --location=global", "Remove-Item data -Recurse", "cp source existing", "Write-Output \"$(Remove-Item data)\"", "node -e 'arbitraryCode()'", "echo ok; rm data"]) {
    assert.equal(assessShellCommand(command, "powershell").confirmation, true, command);
  }
});

test("project scripts and pre/post hooks are inspected before automatic execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-risk-"));
  const save = scripts => writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }));
  try {
    await save({ dev: "next dev --port 30141", test: "vitest run", pretest: "tsc --noEmit", check: "npm run test", postcheck: "eslint src", loop: "npm run loop", deploy: "echo publication" });
    for (const command of ["npm run dev", "pnpm test", "npm run check"]) assert.equal((await assessShellExecution(command, "powershell", root)).confirmation, false, command);
    assert.equal((await assessShellExecution("npm run loop", "powershell", root)).confirmation, true);
    assert.equal((await assessShellExecution("npm run test --prefix other-project", "powershell", root)).confirmation, true);
    assert.equal((await assessShellExecution("npm run test --script-shell other-program", "powershell", root)).confirmation, true);
    assert.equal((await assessShellExecution("npm run test -- --exec other-program", "powershell", root)).confirmation, true);
    assert.equal((await assessShellExecution("npm run test -- --watch", "powershell", root)).confirmation, false);
    assert.equal((await assessShellExecution("npm run deploy", "powershell", root)).confirmation, true);
    await save({ test: "vitest run", pretest: "Remove-Item important -Recurse" });
    const destructive = await assessShellExecution("npm test", "powershell", root);
    assert.equal(destructive.confirmation, true); assert.match(destructive.reason, /pretest/);
    await save({ dev: "npm run nested", nested: "npm publish" });
    assert.equal((await assessShellExecution("npm run dev", "powershell", root)).confirmation, true);
    assert.equal((await assessShellExecution("npm run missing", "powershell", root)).confirmation, true);
    for (const command of ["git fetch origin +main:main", "git fetch --force=true", "git fetch --update-head-ok", "git fetch --prune-tags"]) assert.equal(assessShellCommand(command, "bash").confirmation, true, command);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-shell-risk-"));
    await rm(root, { recursive: true, force: true });
  }
});
