import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import JSZip from "jszip";

const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const store = await jiti.import("./skill-sources/store.ts");
const content = await jiti.import("./skill-sources/content.ts");
const installer = await jiti.import("./skill-sources/install.ts");
const adapters = await jiti.import("./skill-sources/adapters.ts");
const http = await jiti.import("./skill-sources/http.ts");
const catalog = await jiti.import("./skill-sources/catalog.ts");

async function isolated(fn) {
  const root = mkdtempSync(join(tmpdir(), "piora-skills-test-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR, oldHome = process.env.PIORA_HOME, oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PIORA_HOME = root;
  try { await fn(root); }
  finally { if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent; if (oldHome === undefined) delete process.env.PIORA_HOME; else process.env.PIORA_HOME = oldHome; globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
}
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const skill = (name = "demo", version = "1", extra = {}) => ({
  detail: { sourceId: "clawhub", id: "demo", name, version, readme: "", files: ["SKILL.md", "references/a.txt"], ...extra },
  files: new Map([["SKILL.md", Buffer.from(`---\nname: ${name}\ndescription: Example skill\n---\nVersion ${version}\n`)], ["references/a.txt", Buffer.from(`reference ${version}`)]])
});

test("source defaults merge without resurrecting disabled entries; endpoints get new identities and secrets never leak", () => isolated(async () => {
  assert.equal(store.listSources().length, 5);
  assert.equal(store.getSource("skillhub", false).enabled, false);
  await store.saveSource({ ...store.getSource("clawhub"), enabled: false }, "clawhub");
  assert.equal(store.listSources().find(s => s.id === "clawhub").enabled, false);
  const a = await store.saveSource({ name: "Private", kind: "clawhub", url: "https://private.example", credential: "secret" });
  assert.equal(a.hasCredential, true); assert.ok(!JSON.stringify(store.listSources()).includes("secret"));
  await assert.rejects(() => store.saveSource({ name: "Duplicate", kind: "clawhub", url: "https://private.example/" }), /already exists/);
  const b = await store.saveSource({ ...a, url: "https://other.example" }, a.id);
  assert.notEqual(a.id, b.id); assert.equal(b.hasCredential, false); assert.equal(store.sourceCredential(a.id), undefined);
  await store.removeSource("clawhub", true); assert.equal(store.getSource("clawhub").enabled, true);
  await store.removeSource(b.id); assert.throws(() => store.getSource(b.id), /no longer exists/);
}));

test("source validation rejects local transports, embedded credentials, option injection and traversal", () => {
  for (const url of ["file:///tmp/repo", "ext::sh", "--upload-pack=evil", "https://user:secret@example.com/repo"]) assert.throws(() => store.normalizeInput({ name: "bad", kind: "git", url }));
  for (const path of ["../escape", "a/../../b", "a\\b", "C:/file", "/abs", "a/CON", "a/.git/config", "a/trailing."]) assert.throws(() => store.safeRelative(path));
  assert.equal(store.normalizeInput({ name: "Repo", kind: "git", url: "owner/repo" }).url, "https://github.com/owner/repo.git");
  assert.equal(store.normalizeInput({ name: "Repo", kind: "git", url: "git@host.example:team/repo.git" }).url, "git@host.example:team/repo.git");
});

test("HTTP credentials stay on the configured origin, including redirect chains that return to it", () => isolated(async () => {
  const source = { id: "probe", kind: "skillhub", url: "https://private.example", name: "private", enabled: true };
  const calls = [];
  await http.sourceRequest(source, "https://private.example/download", "SECRET", async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.example/file" } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "https://private.example/final" } });
    return new Response("file");
  });
  assert.equal(calls[0].headers["X-API-Key"], "SECRET");
  assert.equal(calls[1].headers["X-API-Key"], undefined); assert.equal(calls[2].headers["X-API-Key"], undefined);
  await assert.rejects(() => http.sourceRequest(source, "https://private.example", "SECRET", async () => new Response(null, { status: 302, headers: { location: "http://private.example" } })), /Insecure/);
}));

test("all three market contracts retain provider identities and pagination; private skills-sh never falls back", () => isolated(async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = new URL(url); calls.push(address);
    if (address.hostname === "sh.example") return json({ data: [{ id: "owner/repo/demo", name: "demo", source: "owner/repo" }], pagination: { hasMore: true } });
    if (address.hostname === "hub.example") return json({ data: { total: 40, skills: [{ slug: "demo", name: "demo", ownerName: "alice", version: "1.0.0" }] } });
    return json({ items: [{ slug: "demo", displayName: "Demo", ownerHandle: "alice", latestVersion: { version: "2.0.0" } }], nextCursor: "opaque" });
  };
  const sh = await adapters.fetchCatalog({ id: "custom-sh", kind: "skills-sh", url: "https://sh.example", enabled: true, name: "sh" });
  const hub = await adapters.fetchCatalog({ id: "custom-hub", kind: "skillhub", url: "https://hub.example", enabled: true, name: "hub" });
  const claw = await adapters.fetchCatalog({ id: "custom-claw", kind: "clawhub", url: "https://claw.example", enabled: true, name: "claw" });
  assert.equal(sh.nextCursor, "1"); assert.equal(hub.nextCursor, "1"); assert.equal(claw.nextCursor, "opaque"); assert.equal(claw.items[0].id, "@alice/demo");
  assert.equal(calls[1].searchParams.get("page"), "1");
  let attempted = 0;
  globalThis.fetch = async url => { attempted++; assert.equal(new URL(url).hostname, "private.example"); throw new Error("offline"); };
  await assert.rejects(() => adapters.fetchCatalog({ id: "private", kind: "skills-sh", url: "https://private.example", enabled: true, name: "private" }, "confidential"));
  assert.equal(attempted, 1);
}));

test("source cache survives a failed refresh, stays isolated, and disabled sources do not make requests", () => isolated(async () => {
  globalThis.fetch = async () => json({ items: [{ slug: "demo", ownerHandle: "one" }] });
  const first = await catalog.catalogPage("clawhub"); assert.equal(first.state, "ready");
  globalThis.fetch = async () => { throw new Error("offline"); };
  const stale = await catalog.catalogPage("clawhub", "", undefined, true); assert.equal(stale.stale, true); assert.equal(stale.items[0].id, "@one/demo");
  const privateSource = await store.saveSource({ name: "Private", kind: "clawhub", url: "https://private.example" });
  assert.equal((await catalog.catalogPage(privateSource.id)).items.length, 0);
  await store.saveSource({ ...store.getSource("clawhub"), enabled: false }, "clawhub");
  assert.equal((await catalog.catalogPage("clawhub")).state, "disabled");
}));

test("archive ingestion preserves support files and rejects traversal, symlinks and duplicate case names", async () => {
  const valid = new JSZip(); valid.file("demo/SKILL.md", skill().files.get("SKILL.md")); valid.file("demo/references/a.txt", "reference");
  const files = await content.unzipSkill(await valid.generateAsync({ type: "nodebuffer" })); assert.equal(files.get("references/a.txt").toString(), "reference");
  const bad = new JSZip(); bad.file("../escape", "oops"); bad.file("SKILL.md", skill().files.get("SKILL.md"));
  await assert.rejects(async () => content.unzipSkill(await bad.generateAsync({ type: "nodebuffer" })));
  const link = new JSZip(); link.file("SKILL.md", skill().files.get("SKILL.md")); link.file("link", "../outside", { unixPermissions: 0o120777 });
  await assert.rejects(async () => content.unzipSkill(await link.generateAsync({ type: "nodebuffer", platform: "UNIX" })), /links/);
  assert.throws(() => content.validateFiles(new Map([["A.txt", Buffer.from("")], ["a.txt", Buffer.from("")]])), /Duplicate/);
});

test("global/project installs preserve files, reject conflicts and serialize concurrent installation", () => isolated(async root => {
  const options = { sourceId: "clawhub", skillId: "demo", scope: "global" };
  const attempts = await Promise.allSettled([installer.commitSkillBundle(options, skill()), installer.commitSkillBundle(options, skill())]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  const info = attempts.find(r => r.status === "fulfilled").value;
  assert.equal(readFileSync(join(root, "agent/skills/demo/references/a.txt"), "utf8"), "reference 1");
  const project = join(root, "project"); mkdirSync(project);
  await installer.commitSkillBundle({ ...options, cwd: project, scope: "project" }, skill());
  assert.ok(existsSync(join(project, ".pi/skills/demo/SKILL.md")));
  assert.equal(installer.findManagedInstall(info.installId, "global").version, "1");
}));

test("updates preserve disable-model-invocation, detect local edits, roll back on record failures and respect pins", () => isolated(async root => {
  const options = { sourceId: "clawhub", skillId: "demo", scope: "global" };
  const installed = await installer.commitSkillBundle(options, skill());
  const target = join(root, "agent/skills/demo/SKILL.md");
  writeFileSync(target, readFileSync(target, "utf8").replace("---\n", "---\ndisable-model-invocation: true\n"));
  const updated = await installer.commitSkillBundle({ ...options, updateId: installed.installId }, skill("demo", "2"));
  assert.equal(updated.versionHash, "2"); assert.match(readFileSync(target, "utf8"), /disable-model-invocation: true/);
  await assert.rejects(() => installer.commitSkillBundle({ ...options, updateId: installed.installId }, skill("demo", "3"), () => { throw new Error("disk failure"); }), /disk failure/);
  assert.match(readFileSync(target, "utf8"), /Version 2/); assert.equal(installer.findManagedInstall(installed.installId, "global").version, "2");
  writeFileSync(target, readFileSync(target, "utf8") + "local edit");
  await assert.rejects(() => installer.commitSkillBundle({ ...options, updateId: installed.installId }, skill("demo", "3")), /edited/);
  const pin = await installer.commitSkillBundle({ ...options, skillId: "pinned" }, skill("pinned", "1", { pinned: true }));
  await assert.rejects(() => installer.commitSkillBundle({ ...options, skillId: "pinned", updateId: pin.installId }, skill("pinned", "2")), /pin/);
  await store.removeSource("clawhub", true);
}));

test("market downloads are versioned ZIPs and skills-sh snapshots reject changes since preview", () => isolated(async () => {
  const zip = new JSZip(); for (const [name, bytes] of skill().files) zip.file(name, bytes);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const calls = [];
  globalThis.fetch = async url => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith("download")) return new Response(bytes, { headers: { "Content-Type": "application/zip" } });
    return json({ skill: { slug: "demo" }, latestVersion: { version: "1.0.0" }, owner: { handle: "alice" } });
  };
  const bundle = await adapters.fetchBundle(store.getSource("clawhub"), "@alice/demo");
  assert.equal(bundle.detail.version, "1.0.0"); assert.equal(calls[0].pathname, "/api/v1/skills/demo"); assert.equal(calls[0].searchParams.get("owner"), "alice"); assert.equal(calls[1].searchParams.get("owner"), "alice"); assert.equal(calls[1].searchParams.get("version"), "1.0.0"); assert.equal(bundle.files.size, 2);
  globalThis.fetch = async () => json({ hash: "new", files: [...skill().files].map(([path, content]) => ({ path, contents: content.toString() })) });
  await assert.rejects(() => adapters.fetchBundle({ id: "self-sh", kind: "skills-sh", url: "https://sh.example", name: "sh", enabled: true }, "owner/repo/demo", "old"), /changed since preview/);
}));

test("source removal and disabling preserve installations and prevent further updates", () => isolated(async root => {
  const source = await store.saveSource({ name: "Team", kind: "clawhub", url: "https://team.example" });
  const installed = await installer.commitSkillBundle({ sourceId: source.id, skillId: "demo", scope: "global" }, skill());
  await store.saveSource({ ...source, enabled: false }, source.id);
  const disabled = await installer.checkManagedUpdate(installed);
  assert.equal(disabled.state, "error"); assert.match(disabled.message, /disabled/);
  await store.removeSource(source.id);
  const removed = await installer.checkManagedUpdate(installed);
  assert.equal(removed.state, "error"); assert.match(removed.message, /no longer exists/);
  assert.ok(existsSync(join(root, "agent/skills/demo/SKILL.md")));
}));

test("a failed first install leaves no files or install record", () => isolated(async root => {
  await assert.rejects(() => installer.commitSkillBundle({ sourceId: "clawhub", skillId: "demo", scope: "global" }, skill(), () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(existsSync(join(root, "agent/skills/demo")), false);
  assert.throws(() => installer.findManagedInstall("missing", "global"), /not found/);
}));

test("custom market rejects publisher substitution", () => isolated(async () => {
  globalThis.fetch = async () => json({ skill: { slug: "demo" }, owner: { handle: "mallory" }, latestVersion: { version: "1.0.0" } });
  await assert.rejects(() => adapters.fetchBundle(store.getSource("clawhub"), "@alice/demo"), /different publisher/);
}));

test("API guards reject cross-site writes and project paths outside the allow-list", () => isolated(async root => {
  const api = await jiti.import("./skill-sources/api.ts");
  assert.throws(() => api.guard(new Request("http://localhost/api/skills/install", { method: "POST", headers: { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" } })), /Untrusted/);
  assert.throws(() => api.guard(new Request("http://localhost/api/skills/install", { method: "POST", headers: { host: "localhost" } })), /Content-Type/);
  const previous = globalThis.__piAllowedRootsCache;
  const allowed = join(root, "allowed"), outside = join(root, "outside"); mkdirSync(allowed); mkdirSync(outside);
  globalThis.__piAllowedRootsCache = { roots: new Set([allowed]), expiresAt: Date.now() + 60000 };
  try {
    assert.equal(await api.allowedCwd(allowed, true), allowed);
    await assert.rejects(() => api.allowedCwd(outside, true), /Access denied/);
    await assert.rejects(() => api.allowedCwd(undefined, true), /required/);
    const file = join(allowed, "file.txt"); writeFileSync(file, "test");
    await assert.rejects(() => api.allowedCwd(file, true), /directory/);
  } finally { globalThis.__piAllowedRootsCache = previous; }
}));

test("source API validates a custom protocol before saving and does not return its credential", () => isolated(async () => {
  const route = await jiti.import("../app/api/skills/sources/route.ts");
  const request = data => new Request("http://localhost/api/skills/sources", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(data) });
  globalThis.fetch = async () => json({ unexpected: [] });
  const data = { name: "Team", kind: "clawhub", url: "https://team.example", credential: "secret-value" };
  assert.equal((await route.POST(request(data))).status, 502); assert.equal(store.listSources().length, 5);
  globalThis.fetch = async (_url, options) => { assert.equal(options.headers.Authorization, "Bearer secret-value"); return json({ items: [] }); };
  const saved = await route.POST(request(data)); assert.equal(saved.status, 200);
  const text = await saved.text(); assert.ok(!text.includes("secret-value")); assert.match(text, /hasCredential/);
  const savedSource = store.listSources().find(s => s.name === "Team"); assert.equal(savedSource.state, "ready");
}));
