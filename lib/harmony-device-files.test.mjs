import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const jiti = createJiti(import.meta.url);
const { validateDeviceFilePath, validateWritableDeviceFilePath, quoteDeviceShell, parseDeviceFileListing } = await jiti.import("./harmony/device-files.ts");
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
  assert.equal(validateWritableDeviceFilePath({ kind: "shared" }, "/data/local/tmp/new.txt"), "/data/local/tmp/new.txt");
  assert.throws(() => validateWritableDeviceFilePath({ kind: "shared" }, "/system/etc/config"));
  assert.throws(() => validateWritableDeviceFilePath({ kind: "sandbox", bundleName: "com.example.app" }, "data/storage"));
});

test("HDC-safe file records preserve spaces and Chinese names while bounding the list", () => {
  const output = Buffer.from(["__PIORA_DIR_OK__", "/data/local/tmp/中文 空格.txt\x1fregular file|12|1790000000|644", "\n/data/local/tmp/sub\x1fdirectory|4096|1790000001|755", "\n__PIORA_TRUNCATED__", ""].join("\x1e"));
  const result = parseDeviceFileListing(output, "/data/local/tmp");
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].name, "sub");
  assert.equal(result.files[1].name, "中文 空格.txt");
  assert.equal(result.files[1].size, 12);
  assert.equal(result.truncated, true);
  assert.throws(() => parseDeviceFileListing(Buffer.from("__PIORA_DIR_ERROR__\x1e"), "/data/local/tmp"));
});

test("HDC listing routes sandbox access through -b without executing a host shell", async () => {
  const calls = [];
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args }) => { calls.push(args); return { stdout: Buffer.from("__PIORA_DIR_OK__\x1e"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; },
  });
  await backend.listFiles("phone", { kind: "sandbox", bundleName: "com.example.app" }, "data/storage/el2/base");
  assert.deepEqual(calls[0].slice(0, 5), ["-t", "phone", "shell", "-b", "com.example.app"]);
  assert.match(calls[0][5], /stat -c/);
  assert.match(calls[0][5], /fmt="%n\$\{us\}%F\|%s\|%Y\|%a\$\{rs\}"/);
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

test("device upload rejects an existing target unless overwrite is explicit and verifies size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-upload-test-"));
  const source = join(directory, "source.txt");
  await writeFile(source, "abc");
  const calls = [];
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  let exists = true, finalizeConflict = false;
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args, operation }) => {
      calls.push({ args, operation });
      const output = operation === "device_upload_preflight" ? exists ? "__PIORA_EXISTS__" : "__PIORA_MISSING__"
        : operation === "device_file_upload" ? "FileTransfer finish, Size:3"
          : operation === "device_upload_finalize" && finalizeConflict ? "__PIORA_EXISTS__" : "3";
      return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  try {
    await assert.rejects(backend.pushFile("phone", { kind: "shared" }, source, "/data/local/tmp/new.txt", false));
    assert.ok(!calls.some(call => call.operation === "device_file_upload"));
    await backend.pushFile("phone", { kind: "shared" }, source, "/data/local/tmp/new.txt", true);
    assert.match(calls.find(call => call.operation === "device_upload_finalize").args.at(-1), /mv -f/);
    calls.length = 0;
    exists = false;
    await backend.pushFile("phone", { kind: "shared" }, source, "/data/local/tmp/new.txt", false);
    assert.ok(calls.some(call => call.operation === "device_file_upload"));
    const transfer = calls.find(call => call.operation === "device_file_upload");
    assert.match(transfer.args.at(-1), /^\/data\/local\/tmp\/new\.txt\.piora-upload-.*\.tmp$/);
    assert.match(calls.find(call => call.operation === "device_upload_finalize").args.at(-1), /mv -n/);
    finalizeConflict = true;
    await assert.rejects(backend.pushFile("phone", { kind: "shared" }, source, "/data/local/tmp/new.txt", false), error => error.code === "STALE_SNAPSHOT");
    assert.ok(calls.some(call => call.operation === "device_upload_cleanup"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("chmod accepts one ordinary device path and verifies the octal mode", async () => {
  const calls = [];
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  let observed = "644";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args, operation }) => {
      calls.push({ args, operation });
      return { stdout: Buffer.from(operation === "device_file_kind" ? "__PIORA_FILE__" : observed), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  await backend.chmodPath("phone", { kind: "shared" }, "/data/local/tmp/note.txt", "644");
  assert.match(calls.at(-1).args.at(-1), /chmod 644/);
  assert.match(calls.at(-1).args.at(-1), /stat -c '%a'/);
  observed = "600";
  await assert.rejects(backend.chmodPath("phone", { kind: "shared" }, "/data/local/tmp/note.txt", "644"), error => error.code === "INVALID_RESPONSE");
  await assert.rejects(backend.chmodPath("phone", { kind: "shared" }, "/data/local/tmp/note.txt", "4755"));
  await assert.rejects(backend.chmodPath("phone", { kind: "shared" }, "/system/secret", "644"));
});

test("device create, delete and rename use non-recursive commands and verify postconditions", async () => {
  const replies = ["__PIORA_MISSING__", "", "__PIORA_DIRECTORY__", "__PIORA_FILE__", "", "__PIORA_MISSING__",
    "__PIORA_FILE__", "__PIORA_MISSING__", "", "__PIORA_MISSING__", "__PIORA_FILE__"];
  const calls = [];
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args }) => { calls.push(args.at(-1)); return { stdout: Buffer.from(replies.shift() ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; },
  });
  const scope = { kind: "shared" };
  await backend.createDirectory("phone", scope, "/data/local/tmp/folder");
  await backend.deletePath("phone", scope, "/data/local/tmp/file.txt");
  await backend.renamePath("phone", scope, "/data/local/tmp/old.txt", "/data/local/tmp/new.txt");
  assert.ok(calls.some(command => command.startsWith("mkdir ")));
  assert.ok(calls.some(command => command.startsWith("rm ")));
  assert.ok(calls.some(command => command.startsWith("mv -n ")));
  assert.ok(calls.every(command => !command.includes("rm -r")));
  await assert.rejects(backend.renamePath("phone", scope, "/data/local/tmp/a", "/system/b"));
});

test("device text preview rejects binary content and returns a content hash", async () => {
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  let payload = Buffer.from("abc");
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args, operation }) => {
      if (operation === "device_file_download") await writeFile(args.at(-1), payload);
      const output = operation === "device_file_kind" ? "__PIORA_FILE__" : operation === "device_file_download" ? "FileTransfer finish" : String(payload.length);
      return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  const scope = { kind: "shared" };
  const preview = await backend.readTextFile("phone", scope, "/data/local/tmp/note.txt");
  assert.equal(preview.text, "abc");
  assert.equal(preview.hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  payload = Buffer.from([0, 1, 2]);
  await assert.rejects(backend.readTextFile("phone", scope, "/data/local/tmp/note.txt"));
});

test("text save rejects stale source and verifies the replacement hash", async () => {
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async () => { throw new Error("Unexpected raw HDC call"); },
  });
  const hash = value => createHash("sha256").update(value).digest("hex");
  let changed = false, uploads = 0;
  backend.readTextFile = async () => ({ text: changed ? "xyz" : "abc", hash: hash(changed ? "xyz" : "abc"), size: 3 });
  backend.pushFile = async () => { uploads++; };
  backend.fileShell = async (_serial, _scope, script) => { assert.match(script, /sha256sum/); assert.match(script, /mv -f/); assert.match(script, /__PIORA_STALE__/); changed = true; return "__PIORA_APPLIED__"; };
  const scope = { kind: "shared" };
  await assert.rejects(backend.saveTextFile("phone", scope, "/data/local/tmp/note.txt", "xyz", hash("older")), error => error.code === "STALE_SNAPSHOT");
  assert.equal(uploads, 0);
  await backend.saveTextFile("phone", scope, "/data/local/tmp/note.txt", "xyz", hash("abc"));
  assert.equal(uploads, 1);
});
