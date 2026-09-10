import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Run only against the verifier's isolated server/project; never a user session. */
export async function verifyPackagedShell({ origin, cwd, token }) {
  const request = async (endpoint, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(origin + "/api/shell/" + endpoint, {
      method, headers: { "X-Pi-Desktop-Token": token, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
    });
    const responseText = await response.text();
    let result;
    try { result = JSON.parse(responseText); }
    catch { result = { error: responseText || "Response did not contain JSON" }; }
    assert.ok(response.ok, "Packaged Shell " + endpoint + " returned " + response.status + ": " + JSON.stringify(result));
    return result;
  };
  const until = async (read, matches) => {
    const deadline = Date.now() + 30000;
    let value;
    do { value = await read(); if (matches(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    throw new Error("Packaged Shell condition timed out: " + JSON.stringify(value));
  };
  await request("settings", { model: null, executable: null, importSystemHistory: false, importPiHistory: false, sources: [] });
  const terminalIds = [];
  try {
    const first = await request("sessions", { cwd }); terminalIds.push(first.session.id);
    const second = await request("sessions", { cwd }); terminalIds.push(second.session.id);
    assert.notEqual(first.session.id, second.session.id);
    const endpoint = "sessions/" + first.session.id;
    const action = body => request(endpoint + "/actions", body);
    await action({ action: "start" });
    const ready = await request(endpoint);
    assert.equal(ready.session.integration, "ready", JSON.stringify(ready.session));
    const powershell = ready.session.profile.kind === "powershell";
    const execute = async (text, clientRequestId = randomUUID()) => {
      const body = { action: "submit", mode: "command", text, clientRequestId };
      const result = await action(body);
      const snapshot = await until(() => request(endpoint), state => state.commands.some(block => block.id === result.command.id && !["accepted", "running"].includes(block.status)));
      const block = snapshot.commands.find(item => item.id === result.command.id);
      assert.equal(block.status, "completed", JSON.stringify(block)); assert.equal(block.exitCode, 0);
      return { body, block };
    };
    await execute(powershell ? "$PioraPackagedValue = 'PERSISTED'" : "PioraPackagedValue=PERSISTED");
    const probe = await execute(powershell ? 'Write-Output "PACKAGED_SHELL_STATE:$PioraPackagedValue"' : 'printf "PACKAGED_SHELL_STATE:%s\\n" "$PioraPackagedValue"');
    assert.match(probe.block.output, /PACKAGED_SHELL_STATE:PERSISTED/);
    const duplicate = await action(probe.body);
    assert.equal(duplicate.command.id, probe.block.id);
    const snapshot = await request(endpoint);
    assert.equal(snapshot.commands.filter(block => block.clientRequestId === probe.body.clientRequestId).length, 1);
    assert.equal((await request("sessions/" + second.session.id)).commands.length, 0);
    const history = await until(() => request("history?q=PACKAGED_SHELL_STATE"), value => value.records.some(record => record.id === probe.block.id));
    assert.ok(history.records.some(record => record.terminalId === first.session.id));
    await request("history/" + probe.block.id, { favorite: true }, "PATCH");
    assert.equal((await request("history/" + probe.block.id)).record.favorite, true);
    await action({ action: "input", data: "exit\r", generation: snapshot.session.generation });
    await until(() => request(endpoint), state => state.session.connected === false);
    assert.equal((await action(probe.body)).command.id, probe.block.id);
    assert.equal((await request(endpoint)).session.connected, false, "receipt recovery must not restart the packaged PTY");
    return { profile: ready.session.profile.kind, persistentState: true, independentTerminals: true, durableRetry: true, historyAndFavorite: true };
  } finally {
    for (const id of terminalIds.reverse()) await request("sessions/" + id, undefined, "DELETE");
  }
}
