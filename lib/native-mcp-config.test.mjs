import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const c = await createJiti(import.meta.url).import("./native-mcp-config.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-native-mcp-config-"));
  const agent = join(root, "agent"), cwd = join(root, "cwd");
  await mkdir(agent); await mkdir(join(cwd, ".pi"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, agent, cwd, global: join(agent, "mcp.json"), project: join(cwd, ".pi/mcp.json") };
}
test("native MCP loads only strict JSON global and trusted project sources with native precedence", async t => {
  const f = await fixture(t);
  await writeFile(f.global, JSON.stringify({ mcpServers: { common: { url: "https://fixture.invalid/mcp", headers: { Authorization: "PRIVATE_GLOBAL" }, auth: { provider: "fixture" }, exposure: "direct" }, replace: { command: "global", env: { PRIVATE: "GLOBAL_ONLY" } }, off: { command: "never-run", enabled: false } } }));
  await writeFile(f.project, JSON.stringify({ mcpServers: { common: { exposure: "deferred", enabled: false }, replace: { command: "project" }, prohibited: { url: "https://fixture.invalid", auth: { provider: "fixture" } } } }));
  await writeFile(join(f.cwd, ".mcp.json"), '{"mcpServers":{"legacy":{"command":"never-run"}}}');
  const untrusted = c.loadNativeMcpConfig(f.agent, f.cwd, false);
  assert.equal(untrusted.servers.find(s => s.name === "replace").config.command, "global");
  assert.equal(untrusted.servers.some(s => s.name === "legacy"), false);
  const trusted = c.loadNativeMcpConfig(f.agent, f.cwd, true);
  assert.equal(trusted.servers.find(s => s.name === "common").config.enabled, false);
  assert.equal(trusted.servers.find(s => s.name === "common").config.headers.Authorization, "PRIVATE_GLOBAL");
  assert.equal(trusted.servers.find(s => s.name === "replace").config.env, undefined);
  assert.equal(trusted.servers.some(s => s.name === "prohibited"), false);
  assert.match(trusted.errors.join(), /prohibited/);
  c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "common", scope: "project", exposure: "codemode" });
  assert.doesNotMatch(JSON.stringify(JSON.parse(await readFile(f.project, "utf8")).mcpServers.common), /PRIVATE_GLOBAL|headers|provider/);
  await writeFile(f.global, '{// JSONC is legacy only\n"mcpServers":{}}');
  assert.match(c.loadNativeMcpConfig(f.agent, f.cwd, false).errors.join(), /strict JSON/);
});
test("native MCP normalizes official streamable-http and codemode-deferred aliases", async t => {
  const f = await fixture(t);
  const raw = { type: "streamable-http", url: "https://fixture.invalid/mcp", exposure: "codemode-deferred", toolExposure: { echo: "codemode-deferred", other: "direct" } };
  const normalized = c.validateNativeMcpConfig(raw, "global");
  assert.equal(normalized.type, "http"); assert.equal(normalized.exposure, "codemode"); assert.equal(normalized.toolExposure.echo, "codemode"); assert.equal(raw.type, "streamable-http");
  c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "alias", scope: "global", config: raw });
  const loaded = c.loadNativeMcpConfig(f.agent, f.cwd, true);
  assert.equal(loaded.errors.length, 0); assert.deepEqual(loaded.servers[0].config, normalized);
  await writeFile(f.project, JSON.stringify({ mcpServers: { alias: { exposure: "codemode-deferred", toolExposure: { echo: "codemode-deferred" } } } }));
  assert.equal(c.loadNativeMcpConfig(f.agent, f.cwd, true).servers[0].config.toolExposure.echo, "codemode");
});
test("native MCP rejects unsupported SSE, ambiguous namespaces, commands in secrets and unsafe writes", async t => {
  const f = await fixture(t);
  for (const config of [ { url: "https://fixture.invalid", type: "sse" }, { command: "node", disabled: true }, { url: "https://fixture.invalid", headers: { Authorization: "!never-execute" } }, { url: "https://fixture.invalid", oauth: { clientSecret: "!never-execute" } }, { command: "node", env: { SECRET: "!never-execute" } }, { url: "https://fixture.invalid", oauth: { callbackUrl: "invalid PRIVATE_SECRET" } } ]) assert.throws(() => c.validateNativeMcpConfig(config, "global"));
  assert.throws(() => c.updateNativeMcpServer(f.agent, f.cwd, false, { name: "x", scope: "project", config: { command: "node" } }), /trust/);
  assert.throws(() => c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "bad name", scope: "global", config: { command: "node" } }), /name/);
  c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "a-b", scope: "global", config: { command: "node", enabled: false } });
  assert.throws(() => c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "a_b", scope: "global", config: { command: "node" } }), /namespace/);
  c.writeNativeMcpPreferences(f.agent, { enabled: true, approvedRegistered: [] });
  if (process.platform !== "win32") assert.equal((await stat(c.nativeMcpPreferencesPath(f.agent))).mode & 0o777, 0o600);
  await rm(join(f.cwd, ".pi"), { recursive: true });
  const outside = join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, join(f.cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => c.updateNativeMcpServer(f.agent, f.cwd, true, { name: "x", scope: "project", config: { command: "node" } }), /symbolic links/);
});
