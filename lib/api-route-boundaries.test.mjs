import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(".") },
});

const worktreeRoute = await jiti.import("../app/api/worktrees/route.ts");
const apiKeyRoute = await jiti.import("../app/api/auth/api-key/[provider]/route.ts");
const loginRoute = await jiti.import("../app/api/auth/login/[provider]/route.ts");
const agentEventsRoute = await jiti.import("../app/api/agent/[id]/events/route.ts");
const extensionsRoute = await jiti.import("../app/api/extensions/route.ts");

function jsonRequest(url, method, body, signal) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function routeContext(values) {
  return { params: Promise.resolve(values) };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function canonicalPath(value) {
  const resolved = fs.realpathSync.native(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

test("extension settings reject untrusted and malformed mutations before touching configuration", async () => {
  const untrusted = await extensionsRoute.PUT(new Request("http://localhost:30141/api/extensions", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
      host: "localhost:30141",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ cwd: process.cwd(), id: "piora:computer", enabled: false }),
  }));
  assert.equal(untrusted.status, 403);

  const malformed = await extensionsRoute.PUT(new Request("http://localhost:30141/api/extensions", {
    method: "PUT",
    headers: { "content-type": "application/json", host: "localhost:30141" },
    body: JSON.stringify({ cwd: process.cwd(), id: "piora:computer" }),
  }));
  assert.equal(malformed.status, 400);
});

test("worktree route reports dirty removal as 409 and accepts an explicit force retry", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "piora-worktree-route-"));
  const repo = path.join(base, "repo");
  const worktreeBase = `${repo}-worktrees`;
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, [
    "-c", "user.name=Piora Test",
    "-c", "user.email=piora@example.invalid",
    "commit", "-m", "fixture",
  ]);

  globalThis.__piAllowedRootsCache = {
    roots: new Set([repo.replace(/\\/g, "/")]),
    expiresAt: Date.now() + 60_000,
  };
  t.after(() => {
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(worktreeBase, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  const createResponse = await worktreeRoute.POST(jsonRequest(
    "http://localhost:30141/api/worktrees",
    "POST",
    { cwd: repo, branch: "route-dirty" },
  ));
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.branch, "route-dirty");
  assert.equal(canonicalPath(created.path), canonicalPath(path.join(worktreeBase, "route-dirty")));

  fs.writeFileSync(path.join(created.path, "untracked.txt"), "dirty\n");
  const dirtyResponse = await worktreeRoute.DELETE(jsonRequest(
    "http://localhost:30141/api/worktrees",
    "DELETE",
    { cwd: repo, path: created.path },
  ));
  const dirty = await dirtyResponse.json();
  assert.equal(dirtyResponse.status, 409, JSON.stringify(dirty));
  assert.equal(dirty.dirty, true);
  assert.equal(fs.existsSync(created.path), true);

  const forceResponse = await worktreeRoute.DELETE(jsonRequest(
    "http://localhost:30141/api/worktrees",
    "DELETE",
    { cwd: repo, path: created.path, force: true },
  ));
  assert.equal(forceResponse.status, 200);
  assert.deepEqual(await forceResponse.json(), { success: true });
  assert.equal(fs.existsSync(created.path), false);
});

test("worktree route rejects a cwd outside the file-access boundary", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "piora-worktree-denied-"));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  globalThis.__piAllowedRootsCache = {
    roots: new Set([allowed.replace(/\\/g, "/")]),
    expiresAt: Date.now() + 60_000,
  };
  t.after(() => {
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const response = await worktreeRoute.GET(new Request(
    `http://localhost:30141/api/worktrees?cwd=${encodeURIComponent(outside)}`,
  ));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("API-key route validates input before auth and exposes status without key material", async () => {
  const response = await apiKeyRoute.POST(
    jsonRequest("http://localhost:30141/api/auth/api-key/example", "POST", { apiKey: "   " }),
    routeContext({ provider: "example" }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "apiKey is required" });

  const provider = "__piora_route_test_unknown__";
  const statusResponse = await apiKeyRoute.GET(
    new Request(`http://localhost:30141/api/auth/api-key/${provider}`),
    routeContext({ provider }),
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(Object.keys(status).sort(), [
    "configured", "displayName", "models", "provider",
  ]);
  assert.equal(status.provider, provider);
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(status).includes("apiKey"), false);
  assert.equal(JSON.stringify(status).includes("key"), false);
});

test("manual auth callback binds tokens to providers, resolves once, and does not echo the code", async (t) => {
  const registry = new Map();
  globalThis.__piLoginCallbacks = registry;
  t.after(() => {
    globalThis.__piLoginCallbacks = undefined;
  });

  const token = "example-123-random";
  const code = "private-manual-code";
  let resolved;
  registry.set(token, {
    resolve(value) { resolved = value; },
    reject() {},
  });

  const mismatch = await loginRoute.POST(
    jsonRequest("http://localhost:30141/api/auth/login/other", "POST", { token, code }),
    routeContext({ provider: "other" }),
  );
  assert.equal(mismatch.status, 400);
  assert.equal(registry.has(token), true);
  assert.equal(resolved, undefined);

  const accepted = await loginRoute.POST(
    jsonRequest("http://localhost:30141/api/auth/login/example", "POST", { token, code }),
    routeContext({ provider: "example" }),
  );
  assert.equal(accepted.status, 200);
  const acceptedText = await accepted.text();
  assert.doesNotMatch(acceptedText, new RegExp(code));
  assert.deepEqual(JSON.parse(acceptedText), { ok: true, provider: "example" });
  assert.equal(resolved, code);
  assert.equal(registry.has(token), false);

  const replay = await loginRoute.POST(
    jsonRequest("http://localhost:30141/api/auth/login/example", "POST", { token, code }),
    routeContext({ provider: "example" }),
  );
  assert.equal(replay.status, 404);
});

test("agent event route emits SSE metadata and unsubscribes on disconnect", async (t) => {
  const id = "route-sse-fixture";
  let listener;
  let unsubscribeCount = 0;
  const fakeSession = {
    runtimeProfile: "normal",
    isAlive: () => true,
    onEvent(callback) {
      listener = callback;
      return () => { unsubscribeCount += 1; };
    },
    destroy() {},
  };
  globalThis.__piSessions = new Map([[id, fakeSession]]);
  t.after(() => {
    globalThis.__piSessions = undefined;
  });

  const abort = new AbortController();
  const response = await agentEventsRoute.GET(
    new Request(`http://localhost:30141/api/agent/${id}/events`, { signal: abort.signal }),
    routeContext({ id }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("connection"), "keep-alive");

  const reader = response.body.getReader();
  const initial = await reader.read();
  const text = new TextDecoder().decode(initial.value);
  assert.match(text, /"type":"connected"/);
  assert.match(text, new RegExp(`"sessionId":"${id}"`));
  assert.equal(typeof listener, "function");

  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsubscribeCount, 1);
  await reader.cancel().catch(() => {});
});
