import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { petNetwork, petCertificates, preparePetNetwork, petDispatcher } = await jiti.import("../desktop/src/dsh-pet-network.ts");
const { petEnvironment, download, removePetDirectory } = await jiti.import("../desktop/src/dsh-pet-install.ts");

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-pet-ca-"));
  t.after(() => removePetDirectory(tmpdir(), root));
  return root;
}

test("system, default, npm and extra CA sources are merged without mutating caller configuration", async t => {
  const root = await temporary(t);
  const extra = join(root, "extra.pem"), npm = join(root, "npm.pem");
  await writeFile(extra, "extra-ca"); await writeFile(npm, "npm-ca");
  const network = petNetwork({ HOME: root, NODE_EXTRA_CA_CERTS: extra, NPM_CONFIG_CAFILE: npm });
  const sources = type => type === "system" ? ["system-ca", "default-ca"] : ["default-ca"];
  assert.deepEqual(petCertificates(network, sources), ["default-ca", "system-ca", "extra-ca", "npm-ca"]);
  const prepared = await preparePetNetwork(root, network, sources);
  assert.equal(network.environment.NODE_EXTRA_CA_CERTS, extra);
  assert.equal(network.environment.NPM_CONFIG_CAFILE, npm);
  assert.equal(prepared.environment.NODE_EXTRA_CA_CERTS, prepared.environment.NPM_CONFIG_CAFILE);
  assert.match(await readFile(prepared.environment.NPM_CONFIG_CAFILE, "utf8"), /default-ca\nsystem-ca\nextra-ca\nnpm-ca/);
  await preparePetNetwork(root, network, type => type === "system" ? ["new-system-ca"] : ["default-ca"]);
  assert.doesNotMatch(await readFile(prepared.environment.NPM_CONFIG_CAFILE, "utf8"), /\nsystem-ca\n/);
  await assert.rejects(preparePetNetwork(root, { ...network, environment: { NPM_CONFIG_CAFILE: join(root, "missing.pem") } }, sources), /ENOENT/);
});

function certificate() {
  const { pki, md } = createRequire(import.meta.url)("node-forge");
  const keys = pki.rsa.generateKeyPair(2048), cert = pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "localhost" }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true }, { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { key: pki.privateKeyToPem(keys.privateKey), cert: pki.certificateToPem(cert) };
}

test("trusted system CA reaches archive fetch and isolated Node/Electron children while unknown CAs remain rejected", { timeout: 30000 }, async t => {
  const root = await temporary(t), identity = certificate();
  const bytes = Buffer.from("archive from enterprise mirror");
  const server = createServer(identity, (req, res) => {
    if (req.url === "/fixture-package") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "fixture-package", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "fixture-package", version: "1.0.0" } } }));
    } else res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `https://127.0.0.1:${server.address().port}/archive`;
  const network = petNetwork({ HOME: root });
  const untrusted = petDispatcher(network);
  const digest = createHash("sha512").update(bytes).digest("base64");
  try { await assert.rejects(download(url, join(root, "bad.tgz"), digest, 1024, AbortSignal.timeout(5000), () => {}, untrusted), /CERT|SELF_SIGNED/); }
  finally { await untrusted.destroy(); }
  // Inject the OS CA reader only; no changes to the user's certificate store.
  const prepared = await preparePetNetwork(root, network, type => type === "system" ? [identity.cert] : []);
  const dispatcher = petDispatcher(prepared);
  try { await download(url, join(root, "ok.tgz"), digest, 1024, AbortSignal.timeout(5000), () => {}, dispatcher); }
  finally { await dispatcher.destroy(); }
  assert.deepEqual(await readFile(join(root, "ok.tgz")), bytes);
  const env = petEnvironment(root, process.env, prepared);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  const script = `const fs=require('node:fs'),https=require('node:https');
    if(!Array.isArray(require('node:tls').getCACertificates('system')))throw Error('system CA reader unavailable');
    fetch(process.argv[1]).then(r=>r.text()).then(text=>{
      if(text!=='archive from enterprise mirror')throw Error(text);
      https.get(process.argv[1],{ca:fs.readFileSync(process.env.NPM_CONFIG_CAFILE)},r=>{if(r.statusCode!==200)process.exitCode=1;r.resume()}).on('error',e=>{console.error(e);process.exitCode=1});
    }).catch(e=>{console.error(e);process.exitCode=1});`;
  for (const executable of [process.execPath, createRequire(import.meta.url)("electron")]) {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ["-e", script, url], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
      let output = ""; child.stderr.on("data", data => { output += data; });
      child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`${executable}: ${output}`)));
    });
  }
  // Exercise npm's own cafile handling, rather than relying only on a Node HTTPS probe.
  const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")]
    .find(file => file && existsSync(file));
  assert.ok(npmCli, "npm CLI must be available in the development/CI runtime");
  await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)("electron"), [npmCli, "view", "fixture-package", "version", `--registry=https://127.0.0.1:${server.address().port}/`, "--fetch-retries=0", "--fetch-timeout=5000", "--ignore-scripts"], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
    child.once("error", reject); child.once("close", code => code === 0 && output.trim() === "1.0.0" ? resolve() : reject(new Error(`npm TLS probe (${code}): ${output} ${error}`)));
  });
});
