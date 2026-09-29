import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { validateTcpDeviceAddress } = await jiti.import("./harmony/tcp-device.ts");
const { HdcBackend } = await jiti.import("./harmony/hdc-backend.ts");

test("manual TCP addresses are canonical private IPv4 endpoints, not arbitrary hosts", () => {
  assert.equal(validateTcpDeviceAddress(" 192.168.1.20:08710 "), "192.168.1.20:8710");
  assert.equal(validateTcpDeviceAddress("10.0.0.1:1"), "10.0.0.1:1");
  for (const value of ["example.com:8710", "8.8.8.8:8710", "192.168.1.1:0", "192.168.1.1:65536", "1.2.3.999:5", "192.168.1.1:5 -remove"]) {
    assert.throws(() => validateTcpDeviceAddress(value), value);
  }
});

test("HDC TCP connect and disconnect require a matching verified device list", async () => {
  const calls = [];
  let listed = false, suppressListing = false;
  const fakePath = "C:\\HarmonySDK\\toolchains\\hdc.exe";
  const backend = new HdcBackend({ hdcPath: fakePath,
    resolve: { platform: "win32", exists: path => path === fakePath, listDirectory: () => [] },
    execute: async ({ args }) => {
      calls.push(args);
      if (args[0] === "tconn") { listed = args.at(-1) !== "-remove"; return { stdout: Buffer.from(listed ? "Connect OK" : "Disconnect OK"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; }
      return { stdout: Buffer.from(listed && !suppressListing ? "192.168.1.20:8710\tConnected\n" : "[Empty]\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  await backend.connectTcpDevice("192.168.1.20:8710", false);
  await backend.connectTcpDevice("192.168.1.20:8710", true);
  assert.deepEqual(calls.filter(args => args[0] === "tconn"), [["tconn", "192.168.1.20:8710"], ["tconn", "192.168.1.20:8710", "-remove"]]);
  suppressListing = true;
  await assert.rejects(backend.connectTcpDevice("192.168.1.20:8710", false), /could not be verified/);
});
