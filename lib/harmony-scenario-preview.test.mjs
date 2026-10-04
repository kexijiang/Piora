import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const route = await jiti.import("../app/api/harmony/scenario/preview/route.ts");

test("scenario preview validates the actual action contract without constructing or accessing a device manager", async () => {
  const previousToken = process.env.PI_DESKTOP_TOKEN;
  const previousManager = Object.getOwnPropertyDescriptor(globalThis, "__pioraHarmonyDeviceManager");
  const token = randomBytes(32).toString("hex"); process.env.PI_DESKTOP_TOKEN = token;
  Object.defineProperty(globalThis, "__pioraHarmonyDeviceManager", { configurable: true, get() { throw new Error("Preview must not access the device manager"); } });
  const submit = (body, headers = {}) => route.POST(new Request("http://localhost:30141/api/harmony/scenario/preview", {
    method: "POST", headers: { host: "localhost:30141", "content-type": "application/json", "x-pi-desktop-token": token, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  try {
    const steps = [
      { action: "launch_app", bundleName: "dev.piora.fixture", abilityName: "EntryAbility" },
      { action: "input_text", selector: { id: "editor", match: "exact" }, text: "中文 $ ` {{target}}" },
      { action: "wait_for", condition: { selector: { text: "已保存" }, timeoutMs: 1000 } },
      { action: "assert", condition: { selector: { text: "未保存" }, exists: false } },
      { action: "checkpoint", name: "after-save" },
    ];
    const valid = await submit({ steps, policy: { captureFinalScreenshot: true } });
    assert.equal(valid.status, 200); assert.match(valid.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await valid.json(), { stepCount: 5, requiredActions: ["launch_app", "input_text", "wait_for", "assert", "checkpoint"], deviceVerified: false });
    for (const invalid of [
      { steps: [] }, { steps: Array(65).fill({ action: "checkpoint", name: "x" }) },
      { steps: [{ action: "tap", selector: {} }] }, { steps: [{ action: "wait_for", condition: { selector: { id: "a" }, timeoutMs: 60001 } }] },
      { steps: [{ action: "input_text", selector: { id: "a" }, text: "x".repeat(8193) }] },
      { steps: [{ action: "shell", command: "rm" }] }, { steps: [{ action: "swipe", direction: "diagonal" }] },
      { steps, policy: { captureFinalScreenshot: "yes" } },
    ]) assert.equal((await submit(invalid)).status, 400);
    assert.equal((await submit("{")).status, 400);
    assert.equal((await submit("x".repeat(128 * 1024 + 1))).status, 413);
    assert.equal((await submit({ steps }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await submit({ steps }, { "x-pi-desktop-token": "wrong" })).status, 403);
    assert.equal((await submit({ steps }, { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" })).status, 403);
  } finally {
    if (previousToken === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = previousToken;
    if (previousManager) Object.defineProperty(globalThis, "__pioraHarmonyDeviceManager", previousManager); else delete globalThis.__pioraHarmonyDeviceManager;
  }
});
