import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ShellProtocolParser } = await jiti.import("./shell/protocol.ts");
const { ShellStore } = await jiti.import("./shell/store.ts");
const { ManagedShellSession } = await jiti.import("./shell/session.ts");
const { discoverShellProfiles, resolveShellProfile } = await jiti.import("./shell/profiles.ts");
const { classifyShellInput } = await jiti.import("./shell/intent.ts");

test("Shell OSC framing preserves output/command ordering at every split", () => {
  const b64 = value => Buffer.from(value).toString("base64");
  const start = `\x1b]633;Piora;token;start;${b64("/tmp") };;id;${b64("echo 中文")}\x07`;
  const end = `\x1b]633;Piora;token;prompt;${b64("/tmp")};0;;\x1b\\`;
  const input = "before" + start + "中文 result" + end + "after";
  for (let split = 0; split <= input.length; split++) {
    const events = [];
    const parser = new ShellProtocolParser("token", e => events.push(e.type), data => events.push(data));
    parser.push(input.slice(0, split)); parser.push(input.slice(split));
    const joined = events.join("|");
    assert.ok(joined.indexOf("start") < joined.indexOf("prompt"));
    assert.equal(events.slice(0, events.indexOf("start")).join(""), "before");
    assert.equal(events.slice(events.indexOf("start") + 1, events.indexOf("prompt")).join(""), "中文 result");
    assert.equal(events.slice(events.indexOf("prompt") + 1).join(""), "after");
  }
  const seen = [];
  const parser = new ShellProtocolParser("other", e => seen.push(e));
  assert.equal(parser.push(start), start); assert.equal(seen.length, 0);
});

async function waitUntil(read, predicate, timeout = process.env.CI ? 120000 : 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Timed out: " + JSON.stringify(await read()));
}
test("managed PTY preserves state, certifies results, isolates sessions and deduplicates submissions", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: process.env.CI ? 240000 : 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-smart-shell-"));
  const child = path.join(root, "child dir"); await mkdir(child);
  const store = new ShellStore(root, false);
  const profiles = (await discoverShellProfiles()).filter(p => p.integrated);
  t.diagnostic(`Verified shell profiles: ${profiles.map(profile => profile.label + " (" + profile.executable + ")").join(", ")}`);
  assert.ok(profiles.length, "An integrated shell must be available");
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.dispose(); await store.close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-smart-shell-")); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const make = profile => {
    const session = new ManagedShellSession({ id: randomUUID(), title: "test", initialCwd: root, cwd: root, profile, createdAt: Date.now(), updatedAt: Date.now(), generation: 0, connected: false, integration: "starting", integrationError: null, owner: "human", activeCommandId: null, activeRunId: null, model: null, draft: "", closed: false }, store, root);
    sessions.push(session);
    session.subscribe(event => { if (event.type === "output" && /\x1b\[c/.test(event.data)) session.input("\x1b[?1;2c", true); });
    return session;
  };
  for (const profile of profiles) {
    const session = make(profile);
    await session.start();
    assert.equal(session.state.integration, "ready", JSON.stringify(session.snapshot()));
    const ps = profile.kind === "powershell";
    const run = async command => {
      const accepted = await session.execute(command, randomUUID());
      return waitUntil(() => session.command(accepted.id), result => result && !["accepted", "running"].includes(result.status));
    };
    const setup = await run(ps ? "$ShellTestValue = 'persistent'; Set-Location 'child dir'" : "ShellTestValue=persistent; cd 'child dir'");
    assert.equal(setup.status, "completed");
    assert.equal(path.basename(session.state.cwd), "child dir");
    await run(ps ? "function global:piora_demo_fn { 'LIVE_FUNCTION' }; Set-Alias -Name piora_demo_alias -Value piora_demo_fn -Scope Global" : "piora_demo_fn() { echo LIVE_FUNCTION; }; alias piora_demo_alias=piora_demo_fn");
    await waitUntil(() => session.commandNames(), names => names.includes("piora_demo_alias") && names.includes("piora_demo_fn"));
    assert.equal(classifyShellInput("piora_demo_alias", session.commandNames()), "command");
    assert.match((await run("piora_demo_alias")).output, /LIVE_FUNCTION/);
    await run(ps ? "Remove-Item Alias:piora_demo_alias; Remove-Item Function:piora_demo_fn" : "unalias piora_demo_alias; unset -f piora_demo_fn");
    await waitUntil(() => session.commandNames(), names => !names.includes("piora_demo_alias") && !names.includes("piora_demo_fn"));
    assert.equal(classifyShellInput("piora_demo_alias", session.commandNames()), "ambiguous");
    const check = await run(ps ? 'Write-Output "STATE:$ShellTestValue"' : 'printf "STATE:%s\\n" "$ShellTestValue"');
    assert.equal(check.exitCode, 0); assert.match(check.output, /STATE:persistent/);
    const failing = await run(ps ? "Write-Error 'INTENTIONAL_FAILURE'" : "false");
    assert.equal(failing.status, "failed", JSON.stringify(failing));
    if (ps) await run("Set-PSReadLineOption -HistorySaveStyle SaveNothing");
    const repeated = ps ? "Write-Output 'REPEATED_RAW_INPUT'" : "echo REPEATED_RAW_INPUT";
    for (let count = 1; count <= 2; count++) {
      session.input(repeated + "\r");
      await waitUntil(() => session.snapshot().commands.filter(block => block.command === repeated && block.status === "completed"), records => records.length === count);
    }
    const requestId = randomUUID();
    const command = ps ? "Write-Output 'ONCE_ONLY'" : "printf 'ONCE_ONLY\\n'";
    const first = await session.execute(command, requestId);
    const duplicate = await session.execute(command, requestId);
    assert.equal(first.id, duplicate.id);
    await waitUntil(() => session.command(first.id), result => result.status === "completed");
    assert.equal(session.snapshot().commands.filter(item => item.clientRequestId === requestId).length, 1);
    await assert.rejects(session.execute(command + " x", requestId), /different content/);
    session.claim("later-task");
    assert.equal((await session.execute(command, requestId)).id, first.id, "receipt remains readable after ownership changes");
    session.release("later-task");
    await session.stop();
    assert.equal((await session.execute(command, requestId)).id, first.id);
    assert.equal(session.state.connected, false, "recovering a receipt must not restart a stopped PTY");
    const second = make(profile); await second.start();
    assert.equal(await realpath(second.state.cwd), await realpath(root)); assert.notEqual(second.state.id, session.state.id);
    await session.dispose(); await second.dispose();
  }
});

test("raw fallback remains interactive without inventing command lifecycle records", { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-raw-"));
  const store = new ShellStore(root, false);
  const profile = await resolveShellProfile(process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  assert.equal(profile.integrated, false);
  const session = new ManagedShellSession({ id: randomUUID(), title: "raw test", initialCwd: root, cwd: root, profile, createdAt: Date.now(), updatedAt: Date.now(), generation: 0, connected: false, integration: "starting", integrationError: null, owner: "human", activeCommandId: null, activeRunId: null, model: null, draft: "", closed: false }, store, root);
  t.after(async () => {
    await session.dispose(); await store.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-shell-raw-"));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await session.start();
  assert.equal(session.state.connected, true);
  assert.equal(session.state.integration, "unavailable");
  await assert.rejects(session.execute("echo forbidden_structured_submission", randomUUID()), error => error.code === "integration_unavailable");
  session.input(process.platform === "win32" ? "set PioraRawSuffix=VERIFIED\r" : "PioraRawSuffix=VERIFIED\r");
  session.input(process.platform === "win32" ? "echo RAW_%PioraRawSuffix%\r" : "printf 'RAW_%s\\n' \"$PioraRawSuffix\"\r");
  await waitUntil(() => session.snapshot(), snapshot => snapshot.output.includes("RAW_VERIFIED"));
  assert.equal(session.snapshot().commands.length, 0);
  assert.equal((await store.history({ query: "RAW_VERIFIED" })).records.length, 0);
  session.input("exit\r");
  await waitUntil(() => session.state.connected, connected => !connected);
  assert.equal(session.snapshot().commands.length, 0, "process exit must not fabricate a successful command");
});
