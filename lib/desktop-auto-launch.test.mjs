import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  readDesktopAutoLaunchState,
  resolveDesktopLoginItemOptions,
  updateDesktopAutoLaunchState,
} = await jiti.import("../desktop/src/auto-launch.ts");

test("auto-launch targets the portable wrapper and stays disabled outside packaged desktop builds", () => {
  assert.deepEqual(resolveDesktopLoginItemOptions({
    platform: "win32",
    isPackaged: true,
    isSmokeTest: false,
    executablePath: "C:\\runtime\\Piora.exe",
    portableExecutablePath: "C:\\Apps\\Piora-portable.exe",
  }), { path: "C:\\Apps\\Piora-portable.exe", args: ["--piora-autostart"] });
  assert.equal(resolveDesktopLoginItemOptions({
    platform: "linux",
    isPackaged: true,
    isSmokeTest: false,
    executablePath: "/opt/piora",
  }), null);
  assert.equal(resolveDesktopLoginItemOptions({
    platform: "win32",
    isPackaged: false,
    isSmokeTest: false,
    executablePath: "C:\\Electron.exe",
  }), null);
});

test("auto-launch writes the OS login item and verifies the effective Windows state", () => {
  let current = { openAtLogin: false, executableWillLaunchAtLogin: false };
  let written;
  const controller = {
    getLoginItemSettings: () => current,
    setLoginItemSettings: (settings) => {
      written = settings;
      current = {
        openAtLogin: settings.openAtLogin,
        executableWillLaunchAtLogin: settings.enabled,
      };
    },
  };
  const options = { path: "C:\\Program Files\\Piora\\Piora.exe", args: [] };

  assert.deepEqual(readDesktopAutoLaunchState(controller, "win32", options), {
    supported: true,
    enabled: false,
  });
  assert.deepEqual(updateDesktopAutoLaunchState(controller, "win32", options, true), {
    supported: true,
    enabled: true,
  });
  assert.deepEqual(written, { ...options, openAtLogin: true, enabled: true });
});

test("the settings switch is connected only through the protected desktop bridge", async () => {
  const [settings, preload, main] = await Promise.all([
    readFile(new URL("../components/DesktopAutoLaunchSetting.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/src/preload.ts", import.meta.url), "utf8"),
    readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /role="switch"/);
  assert.match(settings, /getAutoLaunchState/);
  assert.match(settings, /setAutoLaunchEnabled/);
  assert.match(preload, /pi:auto-launch-get/);
  assert.match(preload, /pi:auto-launch-set/);
  assert.match(main, /isTrustedMainWindowSender/);
  assert.match(main, /registerAutoLaunchHandlers\(\)/);
});

test("existing unmarked Windows login items remain visible and the new registration carries its origin", () => {
  let storedArgs = [];
  const options = { path: "C:\\Apps\\Piora.exe", args: ["--piora-autostart"] };
  const controller = {
    getLoginItemSettings: (requested) => ({
      openAtLogin: JSON.stringify(requested.args) === JSON.stringify(storedArgs),
      executableWillLaunchAtLogin: true,
    }),
    setLoginItemSettings: (value) => { storedArgs = value.args; },
  };
  assert.equal(readDesktopAutoLaunchState(controller, "win32", options).enabled, true);
  assert.equal(updateDesktopAutoLaunchState(controller, "win32", options, true).enabled, true);
  assert.deepEqual(storedArgs, ["--piora-autostart"]);
  assert.equal(readDesktopAutoLaunchState({
    getLoginItemSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: false }),
    setLoginItemSettings: () => {},
  }, "win32", options).enabled, false);
});
