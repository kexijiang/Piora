import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("remote API exposes idempotent Session creation through the shared creation boundary", async () => {
  const [route, shared, durable] = await Promise.all([
    read("../app/api/remote/v1/sessions/route.ts"),
    read("./session-creation.ts"),
    read("./remote-session-creation.ts"),
  ]);
  assert.match(route, /requireRemotePrincipal\(request, "session\.create"\)/);
  assert.match(route, /idempotencyKey\(request\)/);
  assert.match(route, /createSession\(/);
  assert.match(route, /createRemoteSession\(principal, key, input/);
  assert.match(durable, /grantRemoteCapabilitySession/);
  assert.match(shared, /startRpcSession/);
  assert.match(shared, /allowFileRoot\(cwd\)/);
});

test("remote discovery, history, and tools routes each enforce a dedicated scope", async () => {
  const [capabilities, history, tools] = await Promise.all([
    read("../app/api/remote/v1/capabilities/route.ts"),
    read("../app/api/remote/v1/sessions/[id]/history/route.ts"),
    read("../app/api/remote/v1/sessions/[id]/tools/route.ts"),
  ]);
  assert.match(capabilities, /"capabilities\.read"/);
  assert.match(capabilities, /extensionLoading: "best-effort"/);
  assert.match(history, /"session\.history\.read"/);
  assert.match(tools, /"session\.tools\.read"/);
  assert.match(tools, /type: "get_tools"/);
});

test("remote creation policy is checked before session construction and advertised per token",async()=>{
  const route=await read("../app/api/remote/v1/sessions/route.ts");const capabilities=await read("../app/api/remote/v1/capabilities/route.ts");const tokens=await read("../app/api/remote/tokens/route.ts");
  assert.ok(route.indexOf("authorizeRemoteCreation(principal")>=0);assert.ok(route.indexOf("authorizeRemoteCreation(principal")<route.indexOf("await createRemoteSession("));
  assert.match(capabilities,/creationPolicy/);assert.match(tokens,/creationPolicy: body\.creationPolicy/);
});
