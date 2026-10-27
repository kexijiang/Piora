import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";
const { mirrorRouteAllowed, mirrorActionAllowed } = await createJiti(import.meta.url).import("./harmony/mirror-mode.ts");
test("mirror mode admits media and direct input but no workbench streams or new jobs", () => {
  for (const path of ["video", "frame", "geometry", "media", "devices", "manual", "events"]) assert.equal(mirrorRouteAllowed(`/api/harmony/${path}`), true);
  for (const path of ["logs", "logs/events", "device-terminal", "files", "databases", "scenario", "transfers", "audio", "tree"]) assert.equal(mirrorRouteAllowed(`/api/harmony/${path}`), false);
  for (const action of ["tap", "drag", "input_text", "press_key"]) assert.equal(mirrorActionAllowed(action), true);
  for (const action of ["initialize_mirror", "install_app", "uninstall_app", "delete_path", "upload_file", "launch_app", undefined]) assert.equal(mirrorActionAllowed(action), false);
});

test("explicit restricted gateway blocks tool routes and Agent tool registration", async t => {
  const priorMode = process.env.PIORA_HARMONY_WORKBENCH, priorToken = process.env.PI_DESKTOP_TOKEN;
  process.env.PIORA_HARMONY_WORKBENCH = "0"; process.env.PI_DESKTOP_TOKEN = "b".repeat(64);
  t.after(() => {
    if (priorMode === undefined) delete process.env.PIORA_HARMONY_WORKBENCH; else process.env.PIORA_HARMONY_WORKBENCH = priorMode;
    if (priorToken === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = priorToken;
  });
  const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
  const { requireHarmonyAccess } = await jiti.import("../app/api/harmony/_shared.ts");
  const headers = { host: "localhost:30141", "x-pi-desktop-token": process.env.PI_DESKTOP_TOKEN };
  assert.equal(requireHarmonyAccess(new Request("http://localhost:30141/api/harmony/logs/events", { headers })).status, 403);
  for (const route of ["media", "video", "geometry", "manual", "action"]) assert.equal(requireHarmonyAccess(new Request(`http://localhost:30141/api/harmony/${route}`, { headers })), null);
  const { default: register } = await jiti.import("../extensions/piora-harmony.ts");
  let registrations = 0; register({ registerTool() { registrations++; } }); assert.equal(registrations, 0);
});


test("the complete workbench is enabled by default and retains authenticated tools", async t => {
  const previous = process.env.PIORA_HARMONY_WORKBENCH;
  delete process.env.PIORA_HARMONY_WORKBENCH;
  t.after(() => { if (previous === undefined) delete process.env.PIORA_HARMONY_WORKBENCH; else process.env.PIORA_HARMONY_WORKBENCH = previous; });
  const { harmonyWorkbenchEnabled } = await createJiti(import.meta.url).import("./harmony/mirror-mode.ts");
  assert.equal(harmonyWorkbenchEnabled(), true);
  const { default: register } = await createJiti(import.meta.url).import("../extensions/piora-harmony.ts");
  const names = []; register({ registerTool(tool) { names.push(tool.name); }, on() {} });
  assert.ok(names.length > 0, "normal chats retain the existing Harmony tools");
});
