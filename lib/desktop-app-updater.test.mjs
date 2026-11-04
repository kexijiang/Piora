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
  latestVersion = "0.4.12";
  selectedVersion = null;
  downloadedVersion = null;
  installedVersion = null;

  setFeedURL(feed) {
    this.feed = feed;
  }

  async checkForUpdates() {
    this.checkCount += 1;
    this.emit("checking-for-update");
    this.selectedVersion = this.latestVersion;
    this.emit("update-available", {
      version: this.selectedVersion,
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
    this.downloadedVersion = this.selectedVersion;
    this.emit("update-downloaded", { version: this.downloadedVersion });
    return [`Piora-${this.downloadedVersion}-win-x64-setup.exe`];
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.installArguments = [isSilent, isForceRunAfter];
    this.installedVersion = this.downloadedVersion;
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
    audience: "stable", source: "github",
    availableVersion: "0.4.12",
    releaseNotes: "### Fixed\n\n- Kept image messages visible.",
  });

  await controller.downloadUpdate();
  assert.deepEqual(controller.getState(), {
    status: "downloaded",
    currentVersion: "0.4.11",
    audience: "stable", source: "github",
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
    audience: "stable", source: "github",
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
    audience: "stable", source: "github",
    error: "offline",
  });
  assert.ok(logger.entries.some(([level, message]) => level === "error" && message === "Desktop update failed"));
});

test("preview audiences keep prerelease checks enabled and can settle without contacting the backend", async () => {
  const backend = new FakeUpdater();
  let prepareCount = 0;
  const controller = new DesktopUpdateController(backend, "0.4.12-beta.1", createLogger(), {
    audience: "preview", source: "github",
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
    audience: "preview", source: "github",
  });
});

test("download skips the stale notification and goes directly to the latest release", async () => {
  const backend = new FakeUpdater();
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
  await controller.checkForUpdates();
  assert.equal(controller.getState().availableVersion, "0.4.12");
  backend.latestVersion = "0.4.20";
  await Promise.all([controller.downloadUpdate(), controller.downloadUpdate()]);
  assert.equal(backend.checkCount, 2);
  assert.equal(backend.downloadCount, 1);
  assert.equal(backend.downloadedVersion, "0.4.20");
  assert.equal(controller.getState().availableVersion, "0.4.20");
});

test("installation replaces a stale downloaded package with the latest release", async () => {
  const backend = new FakeUpdater();
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
  await controller.checkForUpdates();
  await controller.downloadUpdate();
  backend.latestVersion = "0.4.25";
  assert.equal(await controller.prepareForInstall(), true);
  assert.equal(controller.quitAndInstall(), true);
  assert.equal(backend.installedVersion, "0.4.25");
  assert.equal(backend.checkCount, 3);
});

test("installation revalidates an unchanged downloaded release through the SDK cache path", async () => {
  const backend = new FakeUpdater();
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
  await controller.checkForUpdates();
  await controller.downloadUpdate();
  assert.equal(await controller.prepareForInstall(), true);
  assert.equal(backend.downloadCount, 2);
  assert.equal(controller.getState().status, "downloaded");
  assert.equal(controller.getState().availableVersion, "0.4.12");
});

test("failed freshness checks block stale downloads and installations", async () => {
  for (const downloaded of [false, true]) {
    const backend = new FakeUpdater();
    const controller = new DesktopUpdateController(backend, "0.4.11", createLogger());
    await controller.checkForUpdates();
    if (downloaded) await controller.downloadUpdate();
    const count = backend.downloadCount;
    backend.checkForUpdates = async () => { throw new Error("offline"); };
    if (downloaded) assert.equal(await controller.prepareForInstall(), false);
    else await controller.downloadUpdate();
    assert.equal(controller.getState().status, "error");
    assert.equal(backend.downloadCount, count);
    assert.equal(controller.quitAndInstall(), false);
    assert.equal(backend.installedVersion, null);
  }
});

test("withdrawn releases are not downloaded or installed from stale state", async () => {
  const backend = new FakeUpdater();
  let available = true;
  const controller = new DesktopUpdateController(backend, "0.4.11", createLogger(), {
    prepareCheck: async () => available,
  });
  await controller.checkForUpdates();
  await controller.downloadUpdate();
  available = false;
  assert.equal(await controller.prepareForInstall(), false);
  assert.equal(controller.getState().status, "up-to-date");
  assert.equal(backend.downloadCount, 1);
  assert.equal(controller.quitAndInstall(), false);
});

for (const audience of ["stable", "preview"]) {
  test(`alpha disables all updater actions for persisted ${audience} audience`, async () => {
    const backend = new FakeUpdater();
    const controller = new DesktopUpdateController(backend, "1.2.3-alpha.1", createLogger(), { audience });
    await controller.checkForUpdates();
    await controller.downloadUpdate();
    assert.equal(controller.getState().status, "unsupported");
    assert.equal(controller.quitAndInstall(), false);
    assert.equal(backend.checkCount, 0);
    assert.equal(backend.downloadCount, 0);
    assert.equal(backend.eventNames().length, 0);
  });
}
