import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const require = createRequire(import.meta.url);

test("Windows vault survives an actual Electron safeStorage round trip without plaintext on disk", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-vault-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ts = require("typescript");
  const source = await readFile(new URL("../desktop/src/credential-vault.ts", import.meta.url), "utf8");
  await writeFile(path.join(root, "vault.cjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
  const script = path.join(root, "main.cjs");
  await writeFile(script, `
const {app,safeStorage}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(root, "data"))});
app.whenReady().then(()=>{
 const {CredentialVault}=require('./vault.cjs'); const file=path.join(app.getPath('userData'),'credential-vault.enc');
 const store=new CredentialVault(file,safeStorage); assert.equal(store.available(),true); store.initialize('native-master-password-123');
 store.save({name:'Test',url:'https://example.com/login',username:'native-private-user',password:'native-private-secret'});
 const bytes=fs.readFileSync(file); assert.equal(bytes.includes(Buffer.from('native-private-secret')),false); assert.equal(bytes.includes(Buffer.from('native-private-user')),false);
 const reopened=new CredentialVault(file,safeStorage); reopened.unlock('native-master-password-123'); assert.equal(reopened.status().entries.length,1); assert.equal(JSON.stringify(reopened.status()).includes('native-private-secret'),false);
 console.log('NATIVE_VAULT_OK');app.quit();
}).catch(()=>{console.error('Native vault verification failed');app.exit(1)});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(require("electron"), [script], { env, windowsHide: true, timeout: 30000 });
  assert.match(result.stdout, /NATIVE_VAULT_OK/);
});
