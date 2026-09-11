import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createJiti } from "jiti";
import { powershellManifest, verifyPowerShellArchive, verifyStagedPowerShell } from "../scripts/stage-powershell.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "piora-bundled-pwsh-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-bundled-pwsh-")); await rm(root, { recursive: true, force: true }); });
  return root;
}

test("PowerShell archive verification rejects corrupted and unpinned bytes", async t => {
  const root = await temporary(t), archive = path.join(root, "release.zip");
  await writeFile(archive, "official fixture");
  await verifyPowerShellArchive(archive, createHash("sha256").update("official fixture").digest("hex"));
  await assert.rejects(verifyPowerShellArchive(archive), /SHA-256/);
  await writeFile(archive, "corrupted");
  await assert.rejects(verifyPowerShellArchive(archive, createHash("sha256").update("official fixture").digest("hex")), /SHA-256/);
});

test("packaging requires the full self-contained runtime and upstream notices", async t => {
  const root = await temporary(t);
  for (const name of ["pwsh.exe", "pwsh.dll", "System.Management.Automation.dll", "coreclr.dll", "hostfxr.dll", "hostpolicy.dll", "LICENSE.txt", "ThirdPartyNotices.txt", "bootstrap.cjs"]) await writeFile(path.join(root, name), "fixture");
  await writeFile(path.join(root, "piora-manifest.json"), JSON.stringify(powershellManifest));
  const config = path.join(root, "pwsh.runtimeconfig.json");
  await writeFile(config, JSON.stringify({ runtimeOptions: { includedFrameworks: [{ name: "Microsoft.NETCore.App", version: "10.0.9" }] } }));
  await verifyStagedPowerShell(root);
  await writeFile(config, JSON.stringify({ runtimeOptions: { framework: { name: "Microsoft.NETCore.App" } } }));
  await assert.rejects(verifyStagedPowerShell(root), /include its .NET runtime/);
  await rm(path.join(root, "ThirdPartyNotices.txt"));
  await assert.rejects(verifyStagedPowerShell(root), /ENOENT/);
});

test("bundled bootstrap relocates PowerShell and normalizes only the child PATH", async () => {
  const source = await readFile(new URL("../scripts/powershell-bootstrap.cjs", import.meta.url), "utf8");
  const directory = "D:\\Portable App\\resources\\powershell";
  const env = { Path: "C:\\Windows\\System32", PATH: "ignored duplicate" };
  vm.runInNewContext(source, { process: { platform: "win32", env }, __dirname: directory, require: () => path.win32 });
  assert.equal(env.PIORA_BUNDLED_PWSH, path.win32.join(directory, "pwsh.exe"));
  assert.equal(env.PATH, directory + ";C:\\Windows\\System32");
  assert.equal(env.Path, undefined);
  assert.equal(env.POWERSHELL_UPDATECHECK, "Off");
});

test("Windows default profile uses bundled PowerShell with no installed shell on PATH", { skip: process.platform !== "win32" }, async t => {
  const root = await temporary(t), shell = path.join(root, "pwsh.exe");
  await writeFile(shell, "fixture");
  const original = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original); });
  process.env.PIORA_BUNDLED_PWSH = shell; process.env.PATH = ""; delete process.env.PI_TERMINAL_SHELL;
  const { resolveShellProfile, bundledPowerShellProfile } = await createJiti(import.meta.url).import("./shell/profiles.ts");
  assert.deepEqual(await resolveShellProfile(), { executable: shell, label: "PowerShell 7", kind: "powershell", integrated: true, bundled: true });
  const relocated = path.join(root, "moved"); await mkdir(relocated); await writeFile(path.join(relocated, "pwsh.exe"), "fixture");
  process.env.PIORA_BUNDLED_PWSH = path.join(relocated, "pwsh.exe");
  assert.equal((await bundledPowerShellProfile()).executable, path.join(relocated, "pwsh.exe"));
  const custom = path.join(root, "custom.exe"); await writeFile(custom, "fixture");
  assert.equal((await resolveShellProfile(custom)).executable, custom);
});
