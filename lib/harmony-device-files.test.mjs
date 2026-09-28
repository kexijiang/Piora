import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { validateDeviceFilePath, quoteDeviceShell, parseDeviceFileListing } = await jiti.import("./harmony/device-files.ts");
const { HdcBackend } = await jiti.import("./harmony/hdc-backend.ts");
const { assertScenarioHapsAllowed } = await jiti.import("./harmony/runtime/allowed-hap.ts");

test("device file scopes reject traversal, control bytes and non-sandbox paths", () => {
  assert.equal(validateDeviceFilePath({ kind: "shared" }, "/data/local/tmp"), "/data/local/tmp");
  assert.equal(validateDeviceFilePath({ kind: "sandbox", bundleName: "com.example.app" }, "data/storage/el2/base"), "data/storage/el2/base");
  for (const path of ["/data/../system", "/data/x\nrm -rf /", "relative/path", "/data\\escape"]) {
    assert.throws(() => validateDeviceFilePath({ kind: "shared" }, path));
  }
  assert.throws(() => validateDeviceFilePath({ kind: "sandbox", bundleName: "com.example.app" }, "../outside"));
  assert.throws(() => validateDeviceFilePath({ kind: "sandbox", bundleName: "bad;name" }, "data/storage"));
  assert.equal(quoteDeviceShell("/data/it's safe"), "'/data/it'\\''s safe'");
});

test("NUL file records preserve spaces and Chinese names while bounding the list", () => {
  const output = Buffer.from(["__PIORA_DIR_OK__", "/data/local/tmp/中文 空格.txt", "regular file", "12", "1790000000", "644", "/data/local/tmp/sub", "directory", "4096", "1790000001", "755", ""].join("\0"));
  const result = parseDeviceFileListing(output, "/data/local/tmp");
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].name, "sub");
  assert.equal(result.files[1].name, "中文 空格.txt");
  assert.equal(result.files[1].size, 12);
  assert.throws(() => parseDeviceFileListing(Buffer.from("__PIORA_DIR_ERROR__\0"), "/data/local/tmp"));
});

test("HDC listing routes sandbox access through -b without executing a host shell", async () => {
  const calls = [];
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args }) => { calls.push(args); return { stdout: Buffer.from("__PIORA_DIR_OK__\0"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; },
  });
  await backend.listFiles("phone", { kind: "sandbox", bundleName: "com.example.app" }, "data/storage/el2/base");
  assert.deepEqual(calls[0].slice(0, 5), ["-t", "phone", "shell", "-b", "com.example.app"]);
  assert.match(calls[0][5], /stat -c/);
  assert.equal(calls.length, 1);
});

test("scenario installs cannot read arbitrary host package paths", async () => {
  await assertScenarioHapsAllowed([{ action: "tap", x: 1, y: 1 }]);
  await assert.rejects(assertScenarioHapsAllowed([{ action: "install_app", hapPath: "C:\\missing-outside-workspace.hap" }]),
    error => error.code === "INVALID_ARGUMENT");
});

test("device download stages a complete file and never overwrites a local result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-file-test-"));
  const destination = join(directory, "download.txt");
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const calls = [];
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args }) => {
      calls.push(args);
      if (args.includes("recv")) await writeFile(args.at(-1), "abc");
      return { stdout: Buffer.from(args.includes("recv") ? "FileTransfer finish" : "3\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  try {
    assert.deepEqual(await backend.pullFile("phone", { kind: "shared" }, "/data/local/tmp/source.txt", destination), { destinationPath: destination, size: 3 });
    assert.equal(await readFile(destination, "utf8"), "abc");
    await assert.rejects(backend.pullFile("phone", { kind: "shared" }, "/data/local/tmp/source.txt", destination));
    assert.equal(await readFile(destination, "utf8"), "abc");
    assert.ok(calls.some(args => args.includes("recv")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
