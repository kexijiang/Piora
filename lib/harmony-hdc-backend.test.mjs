import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HdcBackend, HarmonyError, parseHarmonyForwardedPort } = await jiti.import("./harmony/index.ts");

const HDC = "C:\\HarmonySDK\\toolchains\\hdc.exe";

function png(width = 1080, height = 2400) {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function backendWith(execute) {
  return new HdcBackend({
    hdcPath: HDC,
    resolve: { platform: "win32", exists: (path) => path === HDC, listDirectory: () => [] },
    execute,
  });
}

test("parses dynamic Harmony video forwarding ports without accepting invalid values", () => {
  assert.equal(parseHarmonyForwardedPort("tcp:51234 tcp:53535 [Forward]"), 51234);
  assert.equal(parseHarmonyForwardedPort("listen localhost:50123"), 50123);
  assert.equal(parseHarmonyForwardedPort("tcp:0 tcp:53535"), undefined);
  assert.equal(parseHarmonyForwardedPort("tcp:70000 tcp:53535"), undefined);
});

test("discovers verbose HDC targets and probes UiTest capabilities", async () => {
  const calls = [];
  const backend = backendWith(async ({ executable, args }) => {
    calls.push({ executable, args });
    if (args.join(" ") === "list targets -v") {
      return {
        stdout: Buffer.from("alpha USB Connected Mate60 hdc\nbeta TCP Unauthorized Mate70 hdc\ngamma TCP Offline localhost hdc\n"),
        stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
      };
    }
    const command = args.slice(3).join(" ");
    const values = {
      "param get const.product.model": "ALN-AL00\n",
      "param get const.product.name": "HUAWEI Mate 60 Pro\n",
      "settings get secure unified_device_name": "Living room phone\n",
      "param get const.product.devicename": "My phone\n",
      "param get const.product.software.version": "HarmonyOS 6.0\n",
      "param get const.ohos.apiversion": "20\n",
      "uitest --version": "6.1.0.0\n",
    };
    return { stdout: Buffer.from(values[command] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  const devices = await backend.listDevices();
  assert.deepEqual(devices.map(({ serial, state }) => ({ serial, state })), [
    { serial: "alpha", state: "online" },
    { serial: "beta", state: "unauthorized" },
    { serial: "gamma", state: "offline" },
  ]);
  assert.equal(devices[0].model, "ALN-AL00");
  assert.equal(devices[0].product, "HUAWEI Mate 60 Pro");
  assert.equal(devices[0].name, "Living room phone");
  assert.equal(devices[0].capabilities.inputText, true);
  assert.equal(devices[1].capabilities.tap, false);
  assert.ok(calls.every((call) => call.executable === HDC));
  const probeCount = calls.filter((call) => call.args.includes("param") || call.args.includes("--version")).length;
  await backend.listDevices();
  assert.equal(calls.filter((call) => call.args.includes("param") || call.args.includes("--version")).length, probeCount);
});

test("does not turn HDC's verbose empty marker into a phantom online device", async () => {
  const backend = backendWith(async ({ args }) => {
    assert.equal(args.join(" "), "list targets -v");
    return { stdout: Buffer.from("[Empty]\t hdc\r\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.deepEqual(await backend.listDevices(), []);
});

test("rejects shell diagnostics as device identity and refreshes cached names", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let nickname = "My phone";
  const backend = backendWith(async ({ args }) => {
    const values = {
      "list targets -v": "alpha USB Connected hdc",
      "-t alpha shell param get const.product.model": "ALN-AL00",
      "-t alpha shell param get const.product.name": "HUAWEI Mate 60 Pro",
      "-t alpha shell settings get secure unified_device_name": "/system/bin/sh: settings: inaccessible or not found",
      "-t alpha shell param get persist.sys.device_name": "Get parameter persist.sys.device_name failed",
      "-t alpha shell param get const.product.devicename": nickname,
      "-t alpha shell uitest --version": "6.1.0.0",
    };
    return { stdout: Buffer.from(values[args.join(" ")] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.equal((await backend.listDevices())[0].name, "My phone");
  nickname = "Renamed phone";
  assert.equal((await backend.listDevices())[0].name, "My phone");
  t.mock.timers.tick(30_001);
  assert.equal((await backend.listDevices())[0].name, "Renamed phone");
});

test("lists device processes and returns bounded filtered hilog entries", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const command = args.slice(3).join(" ");
    if (command === "ps -A -o PID,NAME") {
      return { stdout: Buffer.from("PID NAME\n42 com.example.demo\n77 render_service\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    if (command.startsWith("hilog ")) {
      return {
        stdout: Buffer.from("08-20 12:34:56.789 42 43 I A00000/App: started\n08-20 12:34:57.001 42 43 E A00000/App: fatal startup failure\n"),
        stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
      };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  assert.deepEqual(await backend.listProcesses("alpha"), [
    { pid: 42, name: "com.example.demo" },
    { pid: 77, name: "render_service" },
  ]);
  const logs = await backend.readLogs("alpha", { pid: 42, level: "error", query: "startup", limit: 50 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].pid, 42);
  assert.match(logs[0].message, /fatal startup failure/);
  const hilog = calls.find((args) => args.includes("hilog"));
  assert.deepEqual(hilog.slice(3), ["hilog", "-z", "50", "-v", "time", "-P", "42", "-L", "E"]);
  assert.equal(hilog.includes("-n"), false);
  assert.equal(hilog.includes("-p"), false);
});

test("treats HDC failure markers as command failures even with exit code zero", async () => {
  const backend = backendWith(async () => ({
    stdout: Buffer.from("[Fail]ExecuteCommand need connect-key?"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    durationMs: 1,
  }));
  await assert.rejects(() => backend.tap("alpha", 10, 20),
    (error) => error instanceof HarmonyError && error.code === "COMMAND_FAILED");
});

test("falls back to legacy target listing when verbose discovery is unsupported", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    if (args.slice(3).join(" ") === "uitest --version") {
      return { stdout: Buffer.from("6.1.0.0\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    if (args.join(" ") === "list targets -v") {
      throw new HarmonyError("COMMAND_FAILED", "unsupported");
    }
    if (args.join(" ") === "list targets") {
      return { stdout: Buffer.from("legacy-phone\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  const devices = await backend.listDevices();
  assert.equal(devices[0].serial, "legacy-phone");
  assert.deepEqual(calls.slice(0, 2), [["list", "targets", "-v"], ["list", "targets"]]);
});

test("reports safe text input unavailable on UiTest versions without coordinate-free text", async () => {
  const backend = backendWith(async ({ args }) => ({
    stdout: Buffer.from(args.slice(3).join(" ") === "uitest --version" ? "5.0.1.2\n" : ""),
    stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
  }));
  await assert.rejects(() => backend.inputText("alpha", "hello"),
    (error) => error instanceof HarmonyError && error.code === "CAPABILITY_UNAVAILABLE");
});

test("captures layout and PNG through generated remote files", async () => {
  const calls = [];
  const tree = { attributes: { type: "Window" }, children: [
    { attributes: { type: "Button", text: "Continue", clickable: true, bounds: "[10,20][110,70]" } },
  ] };
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const recvIndex = args.indexOf("recv");
    if (recvIndex >= 0) {
      const remote = args[recvIndex + 1];
      const local = args[recvIndex + 2];
      writeFileSync(local, remote.endsWith(".png") ? png() : JSON.stringify(tree));
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  const snapshot = await backend.snapshot("alpha", { includeTree: true, includeScreenshot: true });
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(snapshot.nodes[1].bounds, { left: 10, top: 20, right: 110, bottom: 70 });
  assert.equal(snapshot.screenshot.width, 1080);
  assert.equal(snapshot.screenshot.height, 2400);
  assert.ok(calls.some((args) => args.includes("dumpLayout")));
  assert.ok(calls.some((args) => args.includes("screenCap")));
  assert.ok(calls.filter((args) => args.includes("recv")).every((args) => args[0] === "-t" && args[1] === "alpha"));
});

test("never places user text in an HDC or remote-shell argument", async () => {
  const hostile = `hello; touch /data/local/tmp/pwned\n$() \`id\` "quote" 中文`;
  const calls = [];
  let uploaded;
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    if (args.slice(3).join(" ") === "uitest --version") {
      return { stdout: Buffer.from("6.1.0.0\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    const sendIndex = args.indexOf("send");
    if (sendIndex >= 0) uploaded = readFileSync(args[sendIndex + 1], "utf8");
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  await backend.inputText("alpha", hostile);
  assert.equal(uploaded, hostile);
  assert.ok(calls.every((args) => args.every((arg) => !arg.includes(hostile))));
  const remote = calls.find((args) => args.some((arg) => arg.startsWith("v=")));
  assert.equal(remote.length, 4);
  assert.doesNotMatch(remote[3], /\s/);
  assert.match(remote[3], /^v="\$\(cat\$\{IFS\}\/data\/local\/tmp\/piora-input-[0-9a-f-]+\.txt;printf\$\{IFS\}x\)";v="\$\{v%x\}";uitest\$\{IFS\}uiInput\$\{IFS\}text\$\{IFS\}"\$v"$/);
  assert.doesNotMatch(remote[3], /touch|pwned|中文|`id`/);
});

test("uses fixed argument arrays for actions and validates identifiers", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  await backend.tap("alpha", 10, 20);
  await backend.doubleTap("alpha", 10, 20);
  await backend.longPress("alpha", 10, 20);
  await backend.swipe("alpha", 10, 20, 30, 40, 500);
  await backend.fling("alpha", 10, 20, 30, 40, 250);
  await backend.drag("alpha", 10, 20, 30, 40, 800);
  await backend.pressKey("alpha", "recents");
  await backend.launchApp("alpha", "com.example.demo", "EntryAbility");
  const packageRoot = await mkdtemp(join(tmpdir(), "piora-hdc-install-"));
  const hapPath = join(packageRoot, "preview.hap");
  writeFileSync(hapPath, Buffer.from("hap"));
  await backend.installPackage("alpha", hapPath, true);
  await backend.uninstallPackage("alpha", "com.example.demo");

  assert.deepEqual(calls[0], ["-t", "alpha", "shell", "uitest", "uiInput", "click", "10", "20"]);
  assert.deepEqual(calls[1], ["-t", "alpha", "shell", "uitest", "uiInput", "doubleClick", "10", "20"]);
  assert.deepEqual(calls[2], ["-t", "alpha", "shell", "uitest", "uiInput", "longClick", "10", "20"]);
  assert.deepEqual(calls[6], ["-t", "alpha", "shell", "uitest", "uiInput", "keyEvent", "2720"]);
  assert.deepEqual(calls[7], ["-t", "alpha", "shell", "aa", "start", "-b", "com.example.demo", "-a", "EntryAbility"]);
  assert.deepEqual(calls[8], ["-t", "alpha", "install", "-r", hapPath]);
  assert.deepEqual(calls[9], ["-t", "alpha", "uninstall", "com.example.demo"]);
  await rm(packageRoot, { recursive: true, force: true });
  await assert.rejects(() => backend.launchApp("alpha", "com.demo;reboot"),
    (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => backend.installPackage("alpha", "relative-preview.hap", true),
    (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT");
});

test("uses the documented Harmony recorder service and downloads the resulting MP4", async () => {
  const calls = [];
  const directory = await mkdtemp(join(tmpdir(), "piora-harmony-recording-"));
  const destination = join(directory, "recording.mp4");
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const command = args.slice(3).join(" ");
    if (command === "mediatool query piora-recording-12345678.mp4 -u") {
      return { stdout: Buffer.from("/storage/media/100/local/files/Video/piora-recording-12345678.mp4\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    if (args.includes("recv") && args.at(-1) === destination) writeFileSync(destination, Buffer.from("video"));
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  try {
    await backend.startRecording("alpha", "piora-recording-12345678.mp4");
    const bytes = await backend.stopRecording("alpha", "piora-recording-12345678.mp4", destination);
    assert.equal(bytes, 5);
    assert.deepEqual(calls[0], [
      "-t", "alpha", "shell", "aa", "start",
      "-b", "com.huawei.hmos.screenrecorder",
      "-a", "com.huawei.hmos.screenrecorder.ServiceExtAbility",
      "--ps", "CustomizedFileName", "piora-recording-12345678.mp4",
    ]);
    assert.ok(calls.some((args) => args.slice(3).join(" ") === "mediatool query piora-recording-12345678.mp4 -u"));
    assert.ok(calls.some((args) => args[0] === "-t" && args[1] === "alpha" && args[2] === "file" && args[3] === "recv"));
  } finally {
    await backend.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
