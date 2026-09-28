import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { capabilitiesFromHelp } = await createJiti(import.meta.url).import("./harmony/capabilities/probes.ts");
test("unknown help cannot claim a supported action; help evidence is never physical verification", () => {
  const absent = capabilitiesFromHelp({});
  assert.equal(absent.find(item => item.action === "tap").status, "unknown");
  const probed = capabilitiesFromHelp({ input: "click swipe keyEvent", uitest: "dumpLayout" });
  assert.equal(probed.find(item => item.action === "tap").status, "supported");
  assert.equal(probed.find(item => item.action === "double_tap").status, "unsupported");
  assert.equal(probed.find(item => item.action === "install_app").status, "unknown");
  assert.equal(probed.some(item => item.evidence === "verified"), false);
});
