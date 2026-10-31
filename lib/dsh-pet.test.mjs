import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawn } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { PetTaskProjection } = await jiti.import("../desktop/src/dsh-pet-types.ts");
const { verifyDownload, isolateHelper, petEnvironment, removePetDirectory } = await jiti.import("../desktop/src/dsh-pet-install.ts");
const { DshPetManager } = await jiti.import("../desktop/src/dsh-pet-manager.ts");
const task = (id, phase, runtime = "running", kind = "thinking") => ({ id, runtime, activity: { kind }, taskRun: { phase, attempt: 1 } });

test("pet projection prioritizes approvals, tracks terminal transitions, and never celebrates cancellation", () => {
  const p = new PetTaskProjection();
  assert.equal(p.update([task("old", "completed", "idle")], 1), null, "startup must not replay historical success");
  assert.equal(p.update([task("a", "running", "running", "tool"), task("b", "waiting_approval", "idle")], 2), "waiting");
  assert.equal(p.update([task("a", "running", "running", "tool")], 3), "working");
  assert.equal(p.update([task("a", "cancelled", "idle")], 4), null);
  p.update([task("a", "running")], 5);
  assert.equal(p.update([task("a", "completed", "idle")], 6), "success");
  assert.equal(p.update([], 8007), null, "completion expires");
  p.update([task("a", "running")], 9000);
  assert.equal(p.update([task("a", "failed", "idle")], 9001), "error");
  assert.equal(p.update([task("b", "running")], 9002), "thinking", "active work wins over terminal animation");
  assert.equal(p.update([task("b", "cancelled", "idle")], 9003), null, "cancellation cannot resurrect an earlier terminal animation");
  assert.equal(p.update([task("b", "running", "compacting")], 9003), "result");
  p.reset();
  assert.equal(p.update([], 9004), null);
});

test("downloads are integrity checked and helper adaptation refuses unknown upstream layouts", () => {
  const bytes = Buffer.from("archive");
  verifyDownload(bytes, createHash("sha512").update(bytes).digest("base64"));
  assert.throws(() => verifyDownload(Buffer.from("tampered"), createHash("sha512").update(bytes).digest("base64")), /integrity/);
  assert.match(isolateHelper("app.setName('dsh-pet-electron-helper');"), /setPath\('userData'.*DSH_HOME/);
  assert.throws(() => isolateHelper("different upstream"), /layout/);
  assert.throws(() => isolateHelper("app.setName('dsh-pet-electron-helper');app.setName('dsh-pet-electron-helper');"), /layout/);
});

test("runtime directory and inherited DSH settings stay isolated", async () => {
  const root = join(tmpdir(), "piora-pet-environment");
  const env = petEnvironment(root, { DSH_HOME: "other-install", DSH_PET_ELECTRON_PATH: "other-electron", NODE_OPTIONS: "--require other.js", npm_config_registry: "https://other.invalid", OPENAI_API_KEY: "secret", PI_DESKTOP_TOKEN: "private", PATH: "runtime-path" });
  assert.equal(env.DSH_HOME, join(root, "home"));
  assert.equal(env.DSH_PET_ELECTRON_PATH, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NPM_CONFIG_REGISTRY, "https://other.invalid/");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PI_DESKTOP_TOKEN, undefined);
  assert.equal(env.PATH, "runtime-path");
  await assert.rejects(removePetDirectory(root, tmpdir()), /Invalid/);
  await assert.rejects(removePetDirectory(root, root), /Invalid/);
});

async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(50); }
  assert.fail("Timed out waiting for desktop pet fixture");
}

test("manager starts an authenticated child, syncs only state, stops it and keeps data on uninstall", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-dsh-pet-test-"));
  const installed = join(root, "installed");
  const entry = join(installed, "node_modules", "dsh-pet", "lib");
  await mkdir(entry, { recursive: true });
  await writeFile(join(installed, "piora-adapter.json"), JSON.stringify({ version: "0.3.8", adapter: 1 }));
  await writeFile(join(entry, "standalone.js"), `
    function dshHomeDir() { return process.env.DSH_HOME; }
    function electronCacheDir(input) { return 'legacy-cache'; }
    async function downloadFixture() { const zipPath = await downloadArtifact({}); }
    const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
    const home = path.join(process.env.DSH_HOME, 'dsh-pet'); fs.mkdirSync(home, { recursive: true });
    const token = 'a'.repeat(43);
    const server = http.createServer((req, res) => {
      if (req.url === '/health') return res.end('{}');
      if (req.headers['x-dsh-pet-token'] !== token) { res.statusCode=403; return res.end(); }
      if (req.url === '/shutdown') { res.end('{}'); server.close(() => process.exit(0)); return; }
      let body = ''; req.on('data', b => body += b); req.on('end', () => {
        fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify({ method: req.method, body })+'\\n');
        res.end('{}');
      });
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    server.listen(Number(process.argv.at(-1)), '127.0.0.1', () => {
      fs.writeFileSync(path.join(home, 'standalone-runtime.json'), JSON.stringify({pid:process.pid,port:server.address().port,token}));
    });
  `);
  let tasks = [task("private-session-id", "running", "running", "tool")];
  let settingsUrl;
  const manager = new DshPetManager({ root, tasks: async () => tasks, openSettings: async url => { settingsUrl = url; }, openFolder: async () => {}, closeSettings: () => {} });
  t.after(async () => {
    await manager.dispose();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(manager.status().phase, "stopped");
  manager.setPreferences({ autoStart: true });
  assert.throws(() => manager.setPreferences({ executable: "unsafe" }), /Invalid/);
  await assert.rejects(manager.action("arbitrary"), /Unknown/);
  await manager.action("start");
  await until(() => manager.status().phase === "running");
  const requests = join(root, "home", "dsh-pet", "requests.jsonl");
  await until(async () => (await readFile(requests, "utf8").catch(() => "")).includes("working"));
  assert.doesNotMatch(await readFile(requests, "utf8"), /private-session-id/);
  tasks = [task("private-session-id", "completed", "idle")];
  await until(async () => (await readFile(requests, "utf8")).includes("success"));
  manager.setPreferences({ syncTasks: false });
  await until(async () => (await readFile(requests, "utf8")).includes("DELETE"));
  await manager.action("settings");
  assert.match(settingsUrl, /^http:\/\/127\.0\.0\.1:\d+\/standalone-ai\/#token=/);
  assert.equal(JSON.stringify(manager.status()).includes("aaaaa"), false, "IPC status excludes capability");
  const runtime = JSON.parse(await readFile(join(root, "home", "dsh-pet", "standalone-runtime.json"), "utf8"));
  await manager.action("stop");
  await until(() => manager.status().phase === "stopped");
  assert.throws(() => process.kill(runtime.pid, 0), /ESRCH|not found/i);
  // A crashed Piora process must not leave its standalone host behind.
  const parent = spawn(process.execPath, ["-e", `
    require('jiti').createJiti(process.cwd() + '/test-parent.cjs').import('./desktop/src/dsh-pet-manager.ts').then(async ({ DshPetManager }) => {
      const manager = new DshPetManager({ root: process.argv[1], tasks: async () => [], openSettings: async () => {}, openFolder: async () => {}, closeSettings: () => {} });
      await manager.action('start');
      const timer = setInterval(() => {
        if (manager.status().phase === 'running') { clearInterval(timer); process.send('ready'); }
      }, 50);
    });
  `, root], { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  t.after(() => { if (parent.exitCode === null && !parent.signalCode) parent.kill("SIGKILL"); });
  let ready = false, parentError = "";
  parent.stderr.on("data", data => { parentError += data; });
  parent.on("message", message => { if (message === "ready") ready = true; });
  await until(() => { assert.equal(parent.exitCode, null, parentError); return ready; });
  const orphan = JSON.parse(await readFile(join(root, "home", "dsh-pet", "standalone-runtime.json"), "utf8"));
  assert.notEqual(orphan.pid, runtime.pid);
  parent.kill("SIGKILL");
  await until(() => { try { process.kill(orphan.pid, 0); return false; } catch { return true; } });
  await manager.action("uninstall");
  await until(() => manager.status().phase === "absent");
  assert.equal(manager.status().autoStart, false);
  assert.ok(await readFile(requests, "utf8"), "uninstall preserves user data");
});

test("cancelling installation clears staging and preserves user data", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-dsh-pet-cancel-"));
  await writeFile(join(root, "preferences.json"), JSON.stringify({ autoStart: false, syncTasks: false }));
  const stalled = createServer(() => {});
  await new Promise(resolve => stalled.listen(0, "127.0.0.1", resolve));
  t.after(() => { stalled.closeAllConnections(); stalled.close(); });
  const network = () => ({ registry: `http://127.0.0.1:${stalled.address().port}/`, environment: { NO_PROXY: "*" } });
  const manager = new DshPetManager({ root, network, tasks: async () => [], openSettings: async () => {}, openFolder: async () => {}, closeSettings: () => {} });
  t.after(async () => { await manager.dispose(); await removePetDirectory(tmpdir(), root); });
  await manager.action("install");
  await until(() => manager.status().progress?.stage === "installer");
  await manager.action("cancel");
  assert.equal(manager.status().phase, "absent");
  assert.equal(manager.status().error, null);
  assert.equal(manager.status().progress, null);
  await assert.rejects(readFile(join(root, "staging", "npm.tgz")), /ENOENT/);
  assert.equal(JSON.parse(await readFile(join(root, "preferences.json"), "utf8")).syncTasks, false);
});
