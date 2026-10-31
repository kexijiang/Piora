import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { petNetwork, petDispatcher } = await jiti.import("../desktop/src/dsh-pet-network.ts");
const { download, petEnvironment, removePetDirectory, isolateRuntime } = await jiti.import("../desktop/src/dsh-pet-install.ts");
const { preparePetRoot } = await jiti.import("../desktop/src/dsh-pet-paths.ts");

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-pet-network-"));
  t.after(() => removePetDirectory(tmpdir(), root));
  return root;
}

test("npmrc mirror, env precedence and application proxy policy reach isolated children", async t => {
  const root = await temporary(t);
  const config = join(root, ".npmrc");
  await writeFile(config, 'registry="https://mirror.invalid/repository/npm/"\nhttps-proxy=http://user:pass@proxy.invalid:8080\nelectron_mirror=https://electron.invalid/\n//mirror.invalid/:_authToken=secret\n');
  const source = { NPM_CONFIG_USERCONFIG: config, OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require unsafe.js" };
  const network = petNetwork(source);
  assert.equal(network.registry, "https://mirror.invalid/repository/npm/");
  const child = petEnvironment(root, source, network);
  assert.equal(child.NPM_CONFIG_REGISTRY, network.registry);
  assert.equal(child.HTTPS_PROXY, "http://user:pass@proxy.invalid:8080");
  assert.equal(child.ELECTRON_MIRROR, "https://electron.invalid/");
  assert.equal(child.DSH_PET_ELECTRON_MIRROR, child.ELECTRON_MIRROR);
  assert.equal(child.GLOBAL_AGENT_HTTPS_PROXY, child.HTTPS_PROXY);
  assert.equal(child.NODE_USE_ENV_PROXY, "1");
  assert.equal(child.NPM_CONFIG_USERCONFIG, join(root, "npmrc"));
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.doesNotMatch(JSON.stringify(child), /secret/);
  assert.equal(petNetwork({ ...source, npm_config_registry: "https://env.invalid" }).registry, "https://env.invalid/");
  assert.equal(petNetwork({ ...source, npm_config_registry: "https://env.invalid", PIORA_DSH_PET_REGISTRY: "https://explicit.invalid" }).registry, "https://explicit.invalid/");
  const direct = petEnvironment(root, { ...source, https_proxy: "http://stale.invalid" }, petNetwork(source, { mode: "direct", proxyUrl: "", bypass: "" }));
  assert.equal(direct.HTTPS_PROXY, "");
  assert.equal(direct.https_proxy, undefined);
  assert.equal(direct.GLOBAL_AGENT_HTTPS_PROXY, undefined);
  const manual = petNetwork(source, { mode: "manual", proxyUrl: "http://chosen.invalid", bypass: "internal.invalid" });
  assert.equal(manual.environment.HTTPS_PROXY, "http://chosen.invalid");
  assert.match(manual.environment.NO_PROXY, /127\.0\.0\.1.*internal\.invalid/);
});

test("Electron download and cache cleanup use the same private directory, including existing installs", async () => {
  const original = `async function run() { const zipPath = await downloadArtifact({ version: '43.3.0' }); return zipPath; }
    function electronCacheDir(input) { return 'shared-system-cache'; }`;
  const adapted = isolateRuntime(original);
  assert.equal(isolateRuntime(adapted), adapted, "upgrade is idempotent");
  assert.throws(() => isolateRuntime("unexpected upstream source"), /layout/);
  let request;
  const context = { join, dshHomeDir: () => "private-home", downloadArtifact: async value => { request = value; return "archive"; } };
  await runInNewContext(adapted + ";run()", context);
  assert.equal(request.cacheRoot, join("private-home", "electron-cache"));
  assert.equal(runInNewContext("electronCacheDir({})", context), request.cacheRoot);
});

test("archive download sends Basic proxy auth, respects bypass and rejects altered bytes", async t => {
  const root = await temporary(t);
  const payload = Buffer.from("verified archive fixture");
  const integrity = createHash("sha512").update(payload).digest("base64");
  const origin = createServer((_req, res) => res.end(payload));
  const proxy = createServer((req, res) => {
    if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("alice:p@ss").toString("base64")}`) { res.writeHead(407); res.end(); return; }
    authenticated++;
    res.end(payload);
  });
  const sockets = new Set();
  let authenticated = 0;
  proxy.on("connect", (req, socket, head) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("alice:p@ss").toString("base64")}`) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return;
    }
    authenticated++;
    const upstream = connect(origin.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  await new Promise(r => origin.listen(0, "127.0.0.1", r));
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  t.after(() => { for (const socket of sockets) socket.destroy(); origin.closeAllConnections(); origin.close(); proxy.closeAllConnections(); proxy.close(); });
  const network = petNetwork({ HOME: root, HTTP_PROXY: `http://alice:p%40ss@127.0.0.1:${proxy.address().port}` });
  const dispatcher = petDispatcher(network);
  t.after(() => dispatcher.destroy());
  const destination = join(root, "archive.tgz");
  const signal = AbortSignal.timeout(5000);
  await download("http://mirror.invalid/npm/-/npm.tgz", destination, integrity, 1024, signal, () => {}, dispatcher);
  assert.deepEqual(await readFile(destination), payload);
  assert.equal(authenticated, 1);
  await download(`http://127.0.0.1:${origin.address().port}/archive`, destination, integrity, 1024, signal, () => {}, dispatcher);
  assert.equal(authenticated, 1, "loopback bypasses proxy");
  await assert.rejects(download("http://mirror.invalid/tampered", join(root, "bad.tgz"), "wrong", 1024, signal, () => {}, dispatcher), /integrity/);
  await assert.rejects(readFile(join(root, "bad.tgz")), /ENOENT/);
});

test("legacy pet installation migrates once into selected Pi directory without overwriting data", async t => {
  const root = await temporary(t);
  const userData = join(root, "electron");
  const legacy = join(userData, "desktop-extensions", "dsh-pet");
  await mkdir(join(legacy, "home"), { recursive: true });
  await writeFile(join(legacy, "home", "settings.json"), "preserved");
  const target = preparePetRoot(join(root, "custom-agent"), userData);
  assert.equal(target, join(root, "custom-agent", "piora", "desktop-extensions", "dsh-pet"));
  assert.equal(await readFile(join(target, "home", "settings.json"), "utf8"), "preserved");
  assert.equal(await readFile(join(legacy, "home", "settings.json"), "utf8"), "preserved");
  await writeFile(join(target, "home", "settings.json"), "new data");
  preparePetRoot(join(root, "custom-agent"), userData);
  assert.equal(await readFile(join(target, "home", "settings.json"), "utf8"), "new data");
  const switched = preparePetRoot(join(root, "fresh-agent"), userData);
  await assert.rejects(readFile(join(switched, "home", "settings.json")), /ENOENT/, "switch without migration must not resurrect legacy data");
});
