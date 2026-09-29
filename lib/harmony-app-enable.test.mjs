import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { HdcBackend } = await createJiti(import.meta.url).import("./harmony/hdc-backend.ts");

test("app enable/disable targets the active user and requires a success receipt", async () => {
  const calls = [];
  const executable = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  let success = true;
  const backend = new HdcBackend({ hdcPath: executable,
    resolve: { platform: "win32", exists: path => path === executable, listDirectory: () => [] },
    execute: async ({ args }) => { calls.push(args); return { stdout: Buffer.from(success ? `${args[4]} bundle successfully.` : "permission denied"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; },
  });
  await backend.setAppEnabled("phone", "com.example.app", true);
  await backend.setAppEnabled("phone", "com.example.app", false);
  assert.deepEqual(calls.map(args => args.slice(0, 7)), [
    ["-t", "phone", "shell", "bm", "enable", "-n", "com.example.app"],
    ["-t", "phone", "shell", "bm", "disable", "-n", "com.example.app"],
  ]);
  success = false;
  await assert.rejects(backend.setAppEnabled("phone", "com.example.app", true), error => error.code === "CAPABILITY_UNAVAILABLE");
  await assert.rejects(backend.setAppEnabled("phone", "bad;name", true), error => error.code === "INVALID_ARGUMENT");
});
