import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { HdcBackend } = await createJiti(import.meta.url).import("./harmony/hdc-backend.ts");

test("manual device command passes one bounded shell script and parses a private exit marker", async () => {
  const calls = [];
  let script;
  const executable = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: executable,
    resolve: { platform: "win32", exists: path => path === executable, listDirectory: () => [] },
    execute: async options => {
      calls.push(options);
      const transport = options.args.at(-1).match(/^printf %s ([A-Za-z0-9+/]+=*) \| base64 -d \| sh$/);
      assert.ok(transport, "manual sandbox commands must preserve quotes through HDC's parser");
      script = Buffer.from(transport[1], "base64").toString("utf8");
      const marker = script.match(/__PIORA_COMMAND_[a-f0-9]+__/)[0];
      return { stdout: Buffer.from(`done\n${marker}7\n`), stderr: Buffer.from("warning\n"), exitCode: 0, durationMs: 9 };
    },
  });
  const result = await backend.runShellCommand("phone", { kind: "sandbox", bundleName: "com.example.app" }, "printf 'hello'; exit 7");
  assert.deepEqual(result, { stdout: "done", stderr: "warning\n", exitCode: 7, durationMs: 9 });
  assert.deepEqual(calls[0].args.slice(0, 5), ["-t", "phone", "shell", "-b", "com.example.app"]);
  assert.equal(calls[0].timeoutMs, 15_000);
  assert.equal(calls[0].maxOutputBytes, 128 * 1024);
  assert.match(script, /sh -c/);
  assert.equal(calls.length, 1);
  await assert.rejects(backend.runShellCommand("phone", { kind: "shared" }, "bad\0command"));
  await assert.rejects(backend.runShellCommand("phone", { kind: "sandbox", bundleName: "bad;name" }, "pwd"));
  assert.equal(calls.length, 1);
});
