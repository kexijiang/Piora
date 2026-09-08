import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const readerSource = await readFile(new URL("./session-reader.ts", import.meta.url), "utf8");
const prefetchSource = await readFile(new URL("./session-prefetch.ts", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

test("coalesces and reuses unchanged session response projections", () => {
  assert.match(routeSource, /MAX_SESSION_RESPONSE_CACHE_BYTES = 48 \* 1024 \* 1024/);
  assert.match(routeSource, /signature = `\$\{fileState\.size\}:\$\{fileState\.mtimeMs\}:\$\{readPendingSessionModel\(id\)\?\.revision \?\? ""\}:\$\{getRpcSession\(id\)\?\.isRunning\(\) \?\? false\}`/);
  assert.match(routeSource, /if \(!deferThinking \|\| !deferToolResultImages\)/);
  assert.match(routeSource, /existing\?\.signature === signature/);
  assert.match(routeSource, /return existing\.promise/);
  assert.match(routeSource, /JSON\.stringify\(payload\)/);
  assert.match(routeSource, /Buffer\.byteLength\(body, "utf8"\)/);
  assert.match(routeSource, /while \(cachedBytes > MAX_SESSION_RESPONSE_CACHE_BYTES\)/);
});

test("revalidates unchanged serialized session responses with an ETag", () => {
  assert.match(routeSource, /createHash\("sha256"\)/);
  assert.match(routeSource, /req\.headers\.get\("if-none-match"\)/);
  assert.match(routeSource, /return new Response\(null, \{ status: 304, headers \}\)/);
  assert.match(routeSource, /"cache-control": "private, no-cache"/);
});

test("serves live unpersisted sessions without touching the file response cache", () => {
  assert.match(routeSource, /resolveSessionDetailSource\(id/);
  assert.match(routeSource, /if \(source\.kind === "memory"\)/);
  assert.match(routeSource, /source\.manager/);
  assert.match(routeSource, /"cache-control": "private, no-store"/);
  assert.match(routeSource, /isMissingSessionFileError\(error\)/);
  assert.match(routeSource, /invalidateSessionPathCache\(id\)/);
});

test("does not build and discard a second SDK message context", () => {
  assert.doesNotMatch(readerSource, /buildSessionContext as piBuildSessionContext/);
  assert.match(readerSource, /resolveActiveSessionSettings\(entries, leafId, byId\)/);
  assert.match(readerSource, /piBuildContextEntries\(/);
});

test("keeps the initial session projection tree-free unless explicitly requested", () => {
  assert.match(routeSource, /includeTree \? projectTreeForResponse\(sm\.getTree\(\)\) : \[\]/);
  assert.match(routeSource, /const includeTree = searchParams\.has\("includeTree"\)/);
  assert.match(routeSource, /includeTree \? "tree" : "no-tree"/);
});

test("invalidates client switch snapshots whenever a session becomes active", () => {
  assert.match(hookSource, /invalidatePrefetchedSession\(session\.id\)/);
  assert.match(hookSource, /agentRunning \|\| bashRunning \|\| streamState\.isStreaming/);
  assert.match(hookSource, /invalidatePrefetchedSession\(sid\)/);
});

test("renders a prefetched session on the first frame without a loading flash", () => {
  assert.match(prefetchSource, /export function peekPrefetchedSession/);
  assert.match(prefetchSource, /entry\.settled/);
  assert.match(hookSource, /peekPrefetchedSession\(session\)/);
  assert.match(hookSource, /useState<SessionData \| null>\(initialSessionData\)/);
  assert.match(hookSource, /useState\(!isNew && initialSessionData === null\)/);
  assert.match(hookSource, /loadSession\(session\.id, initialSessionData === null/);
  assert.match(chatWindowSource, /session-loading-indicator/);
  assert.match(chatWindowSource, /session-loading-composer/);
});

test("does not remount the chat when the selected session is clicked again", () => {
  assert.match(appShellSource, /selectedSessionIdRef\.current === session\.id/);
  assert.match(appShellSource, /setSessionKey\(\(k\) => k \+ 1\)/);
});
