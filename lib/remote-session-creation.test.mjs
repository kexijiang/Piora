import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./remote-control-store.ts");
const { createRemoteSession } = await jiti.import("./remote-session-creation.ts");

async function isolated(action) {
  const root = mkdtempSync(join(tmpdir(), "piora-creation-recovery-"));
  const previous = { remote: process.env.PIORA_REMOTE_CONTROL_ROOT, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PIORA_REMOTE_CONTROL_ROOT = join(root, "remote");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "vault");
  mkdirSync(cwd);
  try {
    const token = await store.createRemoteCapabilityToken({ name: "synthetic", scopes: ["session.create"], creationPolicy: { allowedPolicies: ["notes"], cwdRoots: [cwd] } });
    const principal = { tokenId: token.record.id, scopes: new Set(["session.create"]), allowedSessionIds: new Set(), allowedRoomIds: new Set() };
    const input = { cwd, remotePolicy: "notes", initialModel: { provider: "synthetic", modelId: "test" }, thinkingLevel: "off", name: "Fixture" };
    await action({ root, principal, input });
  } finally {
    for (const [key, value] of [["PIORA_REMOTE_CONTROL_ROOT", previous.remote], ["PI_CODING_AGENT_DIR", previous.agent]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function created(reservation, input, destroy = () => {}) {
  return { sessionId: reservation.sessionId, cwd: input.cwd, runtimeProfile: "normal", model: input.initialModel, thinkingLevel: "off", capabilities: {}, session: { destroy } };
}

function journalPath(root) {
  const directory = join(root, "remote", "session-creations");
  const files = readdirSync(directory).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 1);
  return join(directory, files[0]);
}

test("a failed initialization retries the durable identity and notes seed instead of creating another session", () => isolated(async ({ root, principal, input }) => {
  let first;
  await assert.rejects(createRemoteSession(principal, "same-key", input, async reservation => {
    first = reservation;
    assert.equal(JSON.parse(readFileSync(journalPath(root), "utf8")).sessionId, reservation.sessionId);
    const entries = readFileSync(reservation.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries[0].id, reservation.sessionId);
    assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "piora-remote-policy" && entry.data.policy === "notes"));
    throw new Error("fixture initialization crash");
  }), /fixture initialization crash/);
  const result = await createRemoteSession(principal, "same-key", input, async reservation => {
    assert.deepEqual(reservation, first);
    return created(reservation, input);
  });
  assert.equal(result.sessionId, first.sessionId);
  assert.equal(store.findRemoteSessionCreation(principal.tokenId, "same-key"), first.sessionId);
  assert.equal(readdirSync(join(first.sessionFile, "..")).filter(name => name.endsWith(".jsonl")).length, 1);
}));

test("concurrent same-key callers initialize once and receive the same owned session", () => isolated(async ({ principal, input }) => {
  let starts = 0;
  const results = await Promise.all(Array.from({ length: 8 }, () => createRemoteSession(principal, "parallel", input, async reservation => {
    starts += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return created(reservation, input);
  })));
  assert.equal(starts, 1);
  assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
  assert.equal(results.filter(result => !result.idempotent).length, 1);
}));

test("the same key with different creation input is rejected without another initialization", () => isolated(async ({ principal, input }) => {
  const first = await createRemoteSession(principal, "bound", input, async reservation => created(reservation, input));
  await assert.rejects(createRemoteSession(principal, "bound", { ...input, name: "Changed" }, async () => assert.fail("must not initialize")), error => error.code === "REMOTE_CREATION_CONFLICT");
  assert.equal(store.findRemoteSessionCreation(principal.tokenId, "bound"), first.sessionId);
}));

test("a corrupt intent fails closed and is not replaced", () => isolated(async ({ root, principal, input }) => {
  await assert.rejects(createRemoteSession(principal, "corrupt", input, async () => { throw new Error("fixture crash"); }), /fixture crash/);
  const path = journalPath(root);
  writeFileSync(path, "corrupt");
  await assert.rejects(createRemoteSession(principal, "corrupt", input, async () => assert.fail("must not initialize")), error => error.code === "REMOTE_CREATION_INVALID");
  assert.equal(readFileSync(path, "utf8"), "corrupt");
}));

test("a ready session survives failed authorization without rerunning initialization on a permitted retry", () => isolated(async ({ principal, input }) => {
  let starts = 0;
  let destroyed = 0;
  let reservation;
  await assert.rejects(createRemoteSession(principal, "ready", input, async value => {
    reservation = value;
    starts += 1;
    await store.revokeRemoteCapabilityToken(principal.tokenId);
    return created(value, input, () => { destroyed += 1; });
  }), /revoked|active|expired/i);
  assert.equal(destroyed, 1);
  assert.equal(store.findRemoteSessionCreation(principal.tokenId, "ready"), undefined);
  await assert.rejects(createRemoteSession(principal, "ready", input, async () => assert.fail("revoked must not initialize")), /revoked|active|expired/i);
  const path = store.getRemoteControlStorePath();
  const data = JSON.parse(readFileSync(path, "utf8"));
  delete data.tokens[0].revokedAt;
  writeFileSync(path, JSON.stringify(data));
  const result = await createRemoteSession(principal, "ready", input, async () => { starts += 1; assert.fail("ready must not initialize again"); });
  assert.equal(starts, 1);
  assert.equal(result.sessionId, reservation.sessionId);
}));

test("a conflicting ownership grant cannot authorize a second session under the same key", () => isolated(async ({ principal }) => {
  await store.grantRemoteCapabilitySession(principal.tokenId, "original", "grant-key");
  await assert.rejects(store.grantRemoteCapabilitySession(principal.tokenId, "different", "grant-key"), /conflict|different|another/i);
  assert.deepEqual(store.readRemoteCapabilityStore().tokens[0].allowedSessionIds, ["original"]);
}));

test("a creation policy changed while the grant waits is rechecked inside the token-store lock", () => isolated(async ({ principal, input }) => {
  const path = store.getRemoteControlStorePath();
    const release = await lockfile.lock(path + ".target", { realpath: false });
  let released = false;
  try {
    const pending = store.grantRemoteCapabilitySession(principal.tokenId, "reserved", "policy-race", path, { policy: "notes", cwd: input.cwd });
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.tokens[0].creationPolicy.allowedPolicies = [];
    writeFileSync(path, JSON.stringify(data));
    await release(); released = true;
    await assert.rejects(pending, /policy|allow/i);
    assert.deepEqual(store.readRemoteCapabilityStore().tokens[0].allowedSessionIds, []);
    assert.equal(store.findRemoteSessionCreation(principal.tokenId, "policy-race"), undefined);
  } finally { if (!released) await release(); }
}));

test("missing or modified initialized seed files are never silently recreated", () => isolated(async ({ principal, input }) => {
  for (const damage of ["missing", "modified"]) {
    let original;
    await assert.rejects(createRemoteSession(principal, damage, input, async reservation => { original = reservation; throw new Error("fixture interruption"); }), /fixture interruption/);
    if (damage === "missing") rmSync(original.sessionFile); else writeFileSync(original.sessionFile, "invalid session seed");
    await assert.rejects(createRemoteSession(principal, damage, input, async () => assert.fail("damaged seed must not initialize")), error => error.code === "REMOTE_CREATION_INVALID");
    if (damage === "missing") assert.equal(existsSync(original.sessionFile), false); else assert.equal(readFileSync(original.sessionFile, "utf8"), "invalid session seed");
    assert.equal(store.findRemoteSessionCreation(principal.tokenId, damage), undefined);
  }
}));

test("a burst of same-key and independent creations keeps ownership and initialization separate", () => isolated(async ({ principal, input }) => {
  const starts = new Map();
  const keys = [...Array(24).fill("burst-shared"), ...Array.from({ length: 6 }, (_, index) => "burst-" + index)];
  const results = await Promise.all(keys.map(key => createRemoteSession(principal, key, input, async reservation => {
    starts.set(key, (starts.get(key) ?? 0) + 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    return created(reservation, input);
  })));
  assert.equal(starts.size, 7);
  assert.ok([...starts.values()].every(count => count === 1));
  assert.equal(new Set(results.map(result => result.sessionId)).size, 7);
  for (let index = 0; index < keys.length; index += 1) assert.equal(store.findRemoteSessionCreation(principal.tokenId, keys[index]), results[index].sessionId);
}));

const workerSource = String.raw`
  import { createJiti } from "jiti";
  const { createRemoteSession } = await createJiti(process.cwd() + "/creation-worker.mjs").import("./lib/remote-session-creation.ts");
  const { principal, input, phase } = JSON.parse(process.argv[1]);
  const hold = setInterval(() => {}, 1000);
  try {
    const result = await createRemoteSession(principal, "process-key", input, async reservation => {
      process.stdout.write(JSON.stringify({ stage: "initializing", ...reservation }) + "\n");
      if (phase === "initializing") await new Promise(() => {});
      return { sessionId: reservation.sessionId, cwd: input.cwd, runtimeProfile: "normal", model: input.initialModel, thinkingLevel: "off", capabilities: {}, session: { destroy() {} } };
    });
    process.stdout.write(JSON.stringify({ stage: "granted", ...result }) + "\n");
  } catch (error) { clearInterval(hold); console.error(error); process.exitCode = 1; }
`;

async function waitFor(predicate, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Timed out: " + description);
}

for (const phase of ["initializing", "ready", "granted"]) {
  test("a killed process recovers the same session at the " + phase + " boundary", { timeout: 45_000 }, () => isolated(async ({ root, principal, input }) => {
    let release;
    if (phase === "ready") release = await lockfile.lock(join(root, "remote"), { lockfilePath: store.getRemoteControlStorePath() + ".lock", realpath: false });
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, JSON.stringify({ principal: { tokenId: principal.tokenId }, input, phase })], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const exit = new Promise(resolve => child.once("exit", resolve));
    try {
      await waitFor(() => { if (child.exitCode !== null) assert.fail(errors); return output.includes("\n"); }, "worker initialization");
      const reservation = JSON.parse(output.split("\n")[0]);
      if (phase === "ready") await waitFor(() => JSON.parse(readFileSync(journalPath(root), "utf8")).phase === "ready", "ready intent before grant");
      if (phase === "granted") await waitFor(() => output.includes('"stage":"granted"'), "ownership grant");
      assert.equal(existsSync(reservation.sessionFile), true);
      assert.equal(child.kill("SIGKILL"), true);
      await exit;
      if (release) { await release(); release = undefined; }
      let starts = 0;
      const result = await createRemoteSession(principal, "process-key", input, async recovered => {
        starts += 1;
        assert.equal(recovered.sessionId, reservation.sessionId);
        assert.equal(recovered.sessionFile, reservation.sessionFile);
        return created(recovered, input);
      });
      assert.equal(starts, phase === "initializing" ? 1 : 0);
      assert.equal(result.sessionId, reservation.sessionId);
      assert.equal(store.findRemoteSessionCreation(principal.tokenId, "process-key"), reservation.sessionId);
      assert.equal(readdirSync(join(reservation.sessionFile, "..")).filter(name => name.endsWith(".jsonl")).length, 1);
    } finally {
      if (release) await release();
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
    }
  }));
}
