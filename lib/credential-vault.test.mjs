import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CredentialVault, credentialUrl } = await jiti.import("../desktop/src/credential-vault.ts");
const master = "correct horse battery staple";
const sample = { name: "Work", url: "https://accounts.example.com/login", username: "private-user-812", password: "private-secret-173", group: "Work", notes: "Private note" };
function cipherFixture() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "piora-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "vault.enc"), cipher = cipherFixture();
  return { root, file, cipher, store: new CredentialVault(file, cipher) };
}

test("vault encrypts disk records, omits secrets in snapshots, retains edited passwords, and locks on restart", async t => {
  const { file, cipher, store } = await fixture(t);
  store.initialize(master); store.save(sample);
  const id = store.status().entries[0].id;
  assert.equal(store.status().autofill, false);
  assert.equal(JSON.stringify(store.status()).includes(sample.password), false);
  store.save({ id, name: "Renamed", password: "" });
  assert.equal(store.credential(id, sample.url).password, sample.password);
  store.record(id, sample.url);
  const bytes = await readFile(file);
  for (const secret of [sample.username, sample.password, sample.notes]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  const restarted = new CredentialVault(file, cipher);
  assert.equal(restarted.status().unlocked, false);
  assert.throws(() => restarted.unlock("wrong password long enough"));
  assert.deepEqual(restarted.status().entries, []);
  restarted.unlock(master);
  assert.equal(restarted.status().audit[0].name, "Renamed");
  restarted.remove(id); assert.deepEqual(restarted.status().entries, []);
});

test("backup requires master verification, authenticates ciphertext, and imports atomically", async t => {
  const { store } = await fixture(t);
  store.initialize(master); store.save(sample);
  assert.throws(() => store.export("different master password"));
  const backup = store.export(master);
  assert.equal(backup.includes(Buffer.from(sample.password)), false);
  assert.throws(() => store.import(backup, "different master password"));
  const tampered = JSON.parse(backup.toString());
  tampered.data = Buffer.alloc(Buffer.from(tampered.data, "base64").length).toString("base64");
  assert.throws(() => store.import(Buffer.from(JSON.stringify(tampered)), master));
  assert.equal(store.status().entries.length, 1);
  store.import(backup, master);
  assert.equal(store.status().entries.length, 2);
  assert.notEqual(store.status().entries[0].id, store.status().entries[1].id);
});

test("matching is exact, autofill opt-in, ambiguous matches explicit, and unavailable encryption fails closed", async t => {
  const { store, file, cipher } = await fixture(t);
  store.initialize(master); store.save(sample);
  assert.deepEqual(store.candidates(sample.url, true), []);
  store.configure(true);
  assert.equal(store.candidates(sample.url, true).length, 1);
  for (const url of ["https://accounts.example.com.evil.com/login", "https://other.example.com/login", "https://accounts.example.com/other", "http://accounts.example.com/login"]) assert.deepEqual(store.candidates(url, false), []);
  for (const url of ["https://xn--example-fake.com/login", "https://127.0.0.1/login", "https://accounts.example.com/checkout", "https://accounts.example.com/settings", "https://user:secret@accounts.example.com/login"]) assert.throws(() => credentialUrl(url));
  store.save({ ...sample, name: "Another account" });
  assert.equal(store.candidates(sample.url, true).length, 2);
  const insecure = new CredentialVault(file, { ...cipher, getSelectedStorageBackend: () => "basic_text" });
  assert.throws(() => insecure.unlock(master));
  store.lock(); assert.deepEqual(store.candidates(sample.url, false), []);
});

test("failed persistence retains the previous valid in-memory record", async t => {
  const { store, cipher } = await fixture(t);
  store.initialize(master); store.save(sample);
  const id = store.status().entries[0].id;
  cipher.encryptString = () => { throw new Error("fixture write failure"); };
  assert.throws(() => store.remove(id));
  assert.equal(store.status().entries[0].id, id);
});

test("desktop IPC rejects untrusted senders and browser guard discards late reads until protected tabs close", async t => {
  const { root } = await fixture(t);
  const electron = path.join(root, "electron.cjs");
  await writeFile(electron, `const handlers=new Map(); module.exports={handlers, app:{getPath:()=>${JSON.stringify(root)}}, ipcMain:{removeHandler:k=>handlers.delete(k),handle:(k,h)=>handlers.set(k,h)}, safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},dialog:{}};`);
  const loader = createJiti(import.meta.url, { alias: { electron } });
  const { registerVaultHandlers, getCredentialVault } = await loader.import("../desktop/src/credential-vault-ipc.ts");
  const stub = await loader.import(electron);
  registerVaultHandlers({ owner: event => event.trusted ? { isDestroyed: () => false } : null, fill: async () => {}, release: async () => {} });
  const handler = stub.handlers.get("pi:credential-vault");
  for (const action of ["status", "initialize", "unlock", "lock", "save", "remove", "configure", "export", "import", "fill", "release"]) await assert.rejects(handler({}, { action }), /Untrusted/);
  const store = getCredentialVault(); store.initialize(master); store.save(sample);
  const { DesktopBrowserManager } = await loader.import("../desktop/src/browser-manager.ts");
  const manager = Object.create(DesktopBrowserManager.prototype);
  manager.startup = { credentialVault: () => store };
  const tab = { id: "one", sessionId: "chat", view: { webContents: { isDestroyed: () => false, getURL: () => sample.url, debugger: { isAttached: () => false }, executeJavaScriptInIsolatedWorld: async () => true } } };
  manager.tabs = [tab]; manager.displayedSessionId = "chat";
  manager.findTab = id => manager.tabs.find(item => item.id === id);
  manager.activeTab = () => tab;
  const calls = [];
  manager.agentControl = { pauseSession: id => calls.push(["pause", id]), resumeSession: id => calls.push(["resume", id]) };
  manager.sendState = () => {}; manager.updateVisibility = () => {};
  manager.closeTab = id => { manager.tabs = manager.tabs.filter(item => item.id !== id); };
  await manager.autoFillCredential(tab);
  assert.deepEqual(calls, [], "autofill starts off");
  store.configure(true); store.save({ ...sample, name: "Another account" });
  await manager.autoFillCredential(tab);
  assert.deepEqual(calls, [], "ambiguous accounts require manual selection");
  store.remove(store.status().entries[1].id);
  let finish;
  const lateRead = manager.credentialGuardedRead("one", () => new Promise(resolve => { finish = resolve; }));
  await manager.fillCredential(store.status().entries[0].id);
  assert.equal(tab.vaultProtected, true);
  finish(sample.password);
  await assert.rejects(lateRead, /private/);
  await assert.rejects(manager.credentialGuardedRead("one", async () => sample.password), /private/);
  assert.deepEqual(calls, [["pause", "chat"]]);
  assert.equal(manager.tabState(tab).url, "about:blank");
  assert.equal(store.status().audit[0].name, sample.name);
  await manager.releaseCredentials();
  assert.equal(manager.tabs.length, 0);
  assert.deepEqual(calls.at(-1), ["resume", "chat"]);
});
