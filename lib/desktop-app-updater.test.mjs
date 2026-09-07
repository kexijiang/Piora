import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { DesktopUpdateController } = await jiti.import("../desktop/src/app-updater.ts");

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = false;
  logger = null;
  checkCount = 0;
  downloadCount = 0;
  installArguments = null;
  channel = null;
  feed = null;

  setFeedURL(feed) {
    this.feed = feed;
  }

  async checkForUpdates() {
    this.checkCount += 1;
    this.emit("checking-for-update");
    this.emit("update-available", {
      version: "0.4.12",
      releaseNotes: "### Fixed\n\n- Kept image messages visible.",
    });
    return {};
  }

  async downloadUpdate() {
    this.downloadCount += 1;
    this.emit("download-progress", {
      percent: 42.4,
      bytesPerSecond: 1_048_576,
      transferred: 44_040_192,
      total: 104_857_600,
    });
    this.emit("update-downloaded", { version: "0.4.12" });
    return ["Piora-0.4.12-win-x64-setup.exe"];
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.installArguments = [isSilent, isForceRunAfter];
  }
}

function createLogger() {
  return {
    entries: [],
    info(message, details) { this.entries.push(["info", message, details]); },
    warn(message, details) { this.entries.push(["warn", message, details]); },
    error(message, details) { this.entries.push(["error", message, details]); },
  };
}

test("scheduled installation passes silent and relaunch flags to NSIS", async () => {
  const backend = new FakeUpdater();
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
  await controller.checkForUpdates(); await controller.downloadUpdate();
  assert.equal(controller.quitAndInstall(true), true);
  assert.deepEqual(backend.installArguments, [true, true]);
});

test("installed desktop updates are user-controlled from check through restart", async () => {
  const backend = new FakeUpdater();
  const controller = new DesktopUpdateController(backend, "v0.4.11", createLogger());
  const states = [];
  controller.subscribe((state) => states.push(state));

  assert.equal(controller.getState().status, "idle");
  assert.equal(backend.autoDownload, false);
  assert.equal(backend.autoInstallOnAppQuit, false);
  assert.equal(backend.autoRunAppAfterInstall, true);
  assert.equal(backend.allowPrerelease, false);

  await controller.checkForUpdates();
  assert.deepEqual(controller.getState(), {
    status: "available",
    currentVersion: "0.4.11",
    audience: "stable",
    availableVersion: "0.4.12",
    releaseNotes: "### Fixed\n\n- Kept image messages visible.",
  });

  await controller.downloadUpdate();
  assert.deepEqual(controller.getState(), {
    status: "downloaded",
    currentVersion: "0.4.11",
    audience: "stable",
    availableVersion: "0.4.12",
    releaseNotes: "### Fixed\n\n- Kept image messages visible.",
    progressPercent: 100,
  });
  assert.equal(controller.quitAndInstall(), true);
  assert.deepEqual(backend.installArguments, [false, true]);
  assert.ok(states.some((state) => state.status === "downloading"
    && state.progressPercent === 42
    && state.bytesPerSecond === 1_048_576
    && state.transferredBytes === 44_040_192
    && state.totalBytes === 104_857_600));
});

test("release-note arrays are normalized into bounded markdown", async () => {
  const backend = new FakeUpdater();
  backend.checkForUpdates = async function checkForUpdates() {
    this.emit("update-available", {
      version: "0.4.13",
      releaseNotes: [
        { version: "0.4.13", note: "- Fixed updater progress" },
        { version: "0.4.12", note: "- Added installed updates" },
      ],
    });
    return {};
  };
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
  await controller.checkForUpdates();
  assert.equal(
    controller.getState().releaseNotes,
    "### v0.4.13\n\n- Fixed updater progress\n\n### v0.4.12\n\n- Added installed updates",
  );
});

test("portable builds expose an unsupported state and never contact an updater", async () => {
  const controller = new DesktopUpdateController(null, "0.4.11", createLogger());
  assert.deepEqual(controller.getState(), {
    status: "unsupported",
    currentVersion: "0.4.11",
    audience: "stable",
  });
  await controller.checkForUpdates();
  await controller.downloadUpdate();
  assert.equal(controller.quitAndInstall(), false);
});

test("update failures become a retryable visible state", async () => {
  const backend = new FakeUpdater();
  backend.checkForUpdates = async function checkForUpdates() {
    this.emit("checking-for-update");
    throw new Error("offline");
  };
  const logger = createLogger();
  const controller = new DesktopUpdateController(backend, "0.4.11", logger);
  await controller.checkForUpdates();
  assert.deepEqual(controller.getState(), {
    status: "error",
    currentVersion: "0.4.11",
    audience: "stable",
    error: "offline",
  });
  assert.ok(logger.entries.some(([level, message]) => level === "error" && message === "Desktop update failed"));
});

test("preview audiences keep prerelease checks enabled and can settle without contacting the backend", async () => {
  const backend = new FakeUpdater();
  let prepareCount = 0;
  const controller = new DesktopUpdateController(backend, "0.4.12-beta.1", createLogger(), {
    audience: "preview",
    prepareCheck: async () => {
      prepareCount += 1;
      return false;
    },
  });

  assert.equal(backend.allowPrerelease, true);
  assert.equal(controller.getState().audience, "preview");
  await controller.checkForUpdates();
  assert.equal(prepareCount, 1);
  assert.equal(backend.checkCount, 0);
  assert.deepEqual(controller.getState(), {
    status: "up-to-date",
    currentVersion: "0.4.12-beta.1",
    audience: "preview",
  });
});
