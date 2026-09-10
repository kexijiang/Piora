import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const store = await jiti.import("./remote-control-store.ts");
const route = await jiti.import("../app/api/remote/tokens/[id]/route.ts");

test("record deletion rejects active tokens and only removes the revoked token's metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-token-records-"));
  const path = join(root, "tokens.json");
  try {
    const target = await store.createRemoteCapabilityToken({ name: "target", scopes: ["session.create"] }, path);
    const other = await store.createRemoteCapabilityToken({ name: "other", scopes: ["session.create"] }, path);
    await store.grantRemoteCapabilitySession(target.record.id, "session-target", "target-key", path);
    await store.grantRemoteCapabilitySession(other.record.id, "session-other", "other-key", path);
    assert.equal(await store.deleteRemoteCapabilityToken(target.record.id, path), "active");
    assert.equal(store.listRemoteCapabilityTokens(path).length, 2);
    assert.ok(store.authenticateRemoteCapabilityToken(target.token, path));
    await store.revokeRemoteCapabilityToken(target.record.id, path);
    assert.equal(store.listRemoteCapabilityTokens(path).length, 2);
    assert.equal(await store.deleteRemoteCapabilityToken(target.record.id, path), "deleted");
    assert.deepEqual(store.listRemoteCapabilityTokens(path).map((token) => token.id), [other.record.id]);
    assert.equal(store.authenticateRemoteCapabilityToken(target.token, path), undefined);
    assert.equal(store.findRemoteSessionCreation(target.record.id, "target-key", path), undefined);
    assert.equal(store.findRemoteSessionCreation(other.record.id, "other-key", path), "session-other");
    assert.ok(store.authenticateRemoteCapabilityToken(other.token, path));
    assert.equal(await store.deleteRemoteCapabilityToken(target.record.id, path), "not_found");
    await assert.rejects(store.grantRemoteCapabilitySession(target.record.id, "late-session", "late-key", path), /no longer active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired records can be deleted without revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-expired-records-"));
  const path = join(root, "tokens.json");
  try {
    const target = await store.createRemoteCapabilityToken({ name: "expired", scopes: ["session.state.read"], expiresAt: Date.now() + 100 }, path);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(store.listRemoteCapabilityTokens(path)[0].active, false);
    assert.equal(await store.deleteRemoteCapabilityToken(target.record.id, path), "deleted");
    assert.equal(store.authenticateRemoteCapabilityToken(target.token, path), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE preserves revocation semantics and explicitly gates permanent deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-record-route-"));
  const previousRoot = process.env.PIORA_REMOTE_CONTROL_ROOT;
  process.env.PIORA_REMOTE_CONTROL_ROOT = root;
  try {
    const target = await store.createRemoteCapabilityToken({ name: "route", scopes: ["session.state.read"] });
    const request = (permanent) => route.DELETE(new Request("http://localhost/api/remote/tokens/" + target.record.id + (permanent ? "?permanent=true" : ""), { method: "DELETE" }), { params: Promise.resolve({ id: target.record.id }) });
    assert.equal((await request(true)).status, 409);
    const revoked = await request(false);
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { revoked: true });
    assert.equal(store.listRemoteCapabilityTokens().length, 1);
    assert.equal(store.listRemoteCapabilityTokens()[0].active, false);
    const deleted = await request(true);
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal(store.listRemoteCapabilityTokens().length, 0);
    assert.equal((await request(true)).status, 404);
  } finally {
    if (previousRoot === undefined) delete process.env.PIORA_REMOTE_CONTROL_ROOT;
    else process.env.PIORA_REMOTE_CONTROL_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
