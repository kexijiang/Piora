import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  preparePreviewUpdateFeed,
  releaseTagsFromAtom,
  selectDesktopReleaseCandidate,
} = await jiti.import("../desktop/src/update-release-selector.ts");
const { DesktopUpdateController } = await jiti.import("../desktop/src/app-updater.ts");

const feed = (tags) => tags.map((tag) => (
  `<entry><link href="https://github.com/kexijiang/Piora/releases/tag/${tag}" /></entry>`
)).join("\n");
const logger = { info() {}, warn() {}, error() {} };
const response = (status, body = "") => ({ ok: status === 200, status, text: async () => body });

function createUpdater() {
  return {
    allowPrerelease: false,
    allowDowngrade: true,
    channel: null,
    feed: null,
    checkCount: 0,
    on() {},
    setFeedURL(value) { this.feed = value; },
    async checkForUpdates() { this.checkCount += 1; },
  };
}

test("release tags are de-duplicated from the GitHub Atom feed", () => {
  assert.deepEqual(releaseTagsFromAtom(feed(["v0.4.40", "v0.4.40-beta.2", "v0.4.40"])), [
    "v0.4.40",
    "v0.4.40-beta.2",
  ]);
});

test("preview users receive the highest semantic version across stable and beta releases", () => {
  const unordered = ["harmony-v0.4.39", "v0.4.40-beta.4", "v0.4.40", "v0.4.41-beta.2", "v0.4.41-beta.1"];
  assert.deepEqual(selectDesktopReleaseCandidate(unordered, "0.4.39", "preview"), {
    tag: "v0.4.41-beta.2",
    version: "0.4.41-beta.2",
    channel: "beta",
  });
  assert.deepEqual(selectDesktopReleaseCandidate(unordered, "0.4.41-beta.2", "preview"), null);
  assert.deepEqual(selectDesktopReleaseCandidate(["v0.4.41-beta.2", "v0.4.41"], "0.4.41-beta.2", "preview"), {
    tag: "v0.4.41",
    version: "0.4.41",
    channel: "latest",
  });
});

test("stable users ignore beta releases", () => {
  assert.deepEqual(selectDesktopReleaseCandidate(["v0.4.41-beta.9", "v0.4.40"], "0.4.39", "stable"), {
    tag: "v0.4.40",
    version: "0.4.40",
    channel: "latest",
  });
});

test("preview feed preparation pins the selected GitHub release and disables downgrade", async () => {
  const updater = createUpdater();
  const requests = [];
  const prepared = await preparePreviewUpdateFeed(
    updater,
    "0.4.39",
    async (url) => {
      requests.push(url);
      return response(200, url.endsWith(".atom")
        ? feed(["v0.4.40", "v0.4.41-beta.2"])
        : "version: 0.4.41-beta.2");
    },
    logger,
  );

  assert.equal(prepared, true);
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.channel, "beta");
  assert.deepEqual(updater.feed, {
    provider: "generic",
    url: "https://github.com/kexijiang/Piora/releases/download/v0.4.41-beta.2",
    channel: "beta",
  });
  assert.deepEqual(requests, [
    "https://github.com/kexijiang/Piora/releases.atom",
    "https://github.com/kexijiang/Piora/releases/download/v0.4.41-beta.2/beta.yml",
  ]);
});

test("failed release tags are skipped in version order until published metadata is found", async () => {
  const updater = createUpdater();
  const requests = [];
  const prepared = await preparePreviewUpdateFeed(updater, "0.4.41-beta.43", async (url) => {
    requests.push(url);
    if (url.endsWith(".atom")) return response(200, feed([
      "v0.4.41-beta.44", "v0.4.41-beta.46", "v0.4.41-beta.43", "v0.4.41-beta.45",
    ]));
    if (url.includes("beta.46/")) return response(404);
    if (url.includes("beta.45/")) return response(410);
    return response(200, "version: 0.4.41-beta.44");
  }, logger);
  assert.equal(prepared, true);
  assert.equal(updater.feed.url, "https://github.com/kexijiang/Piora/releases/download/v0.4.41-beta.44");
  assert.deepEqual(requests.slice(1).map((url) => url.split("/").slice(-2).join("/")), [
    "v0.4.41-beta.46/beta.yml", "v0.4.41-beta.45/beta.yml", "v0.4.41-beta.44/beta.yml",
  ]);
});

test("beta never probes release metadata even when a newer release exists", async () => {
  const updater = createUpdater();
  const requests = [];
  const controller = new DesktopUpdateController(updater, "0.4.41-beta.44", logger, {
    audience: "preview", source: "github",
    prepareCheck: () => preparePreviewUpdateFeed(updater, "0.4.41-beta.44", async (url) => {
      requests.push(url);
      return url.endsWith(".atom")
        ? response(200, feed(["v0.4.41-beta.45", "v0.4.41-beta.44", "v0.4.41-beta.43"]))
        : response(404);
    }, logger),
  });
  await controller.checkForUpdates();
  assert.deepEqual(controller.getState(), {
    status: "unsupported", unsupportedReason: "non-stable", currentVersion: "0.4.41-beta.44", audience: "preview", source: "github",
  });
  assert.equal(updater.checkCount, 0);
  assert.equal(updater.feed, null);
  assert.equal(requests.length, 0, "beta must not probe any version");
});

test("a preview user can fall back from an unpublished beta to a newer published stable release", async () => {
  const updater = createUpdater();
  const requests = [];
  assert.equal(await preparePreviewUpdateFeed(updater, "0.4.40-beta.1", async (url) => {
    requests.push(url);
    if (url.endsWith(".atom")) return response(200, feed(["v0.4.41-beta.1", "v0.4.40"]));
    return url.endsWith("beta.yml") ? response(404) : response(200, "version: 0.4.40");
  }, logger), true);
  assert.equal(updater.channel, "latest");
  assert.equal(requests.at(-1), "https://github.com/kexijiang/Piora/releases/download/v0.4.40/latest.yml");
});

test("metadata HTTP and transport failures remain visible instead of being reported as no update", async () => {
  for (const failure of [403, 429, 500, new Error("net::ERR_CONNECTION_RESET")]) {
    const updater = createUpdater();
    const controller = new DesktopUpdateController(updater, "0.4.44", logger, {
      audience: "stable", source: "github",
      prepareCheck: () => preparePreviewUpdateFeed(updater, "0.4.44", async (url) => {
        if (url.endsWith(".atom")) return response(200, feed(["v0.4.45"]));
        if (failure instanceof Error) throw failure;
        return response(failure);
      }, logger),
    });
    await controller.checkForUpdates();
    assert.equal(controller.getState().status, "error");
    assert.match(controller.getState().error, failure instanceof Error ? /ERR_CONNECTION_RESET/ : new RegExp(`HTTP ${failure}`));
    assert.equal(updater.checkCount, 0);
    assert.equal(updater.feed, null);
  }
});

test("a missing Atom feed is a check failure, not an unpublished candidate", async () => {
  await assert.rejects(
    preparePreviewUpdateFeed(createUpdater(), "0.4.41-beta.44", async () => response(404), logger),
    /Release feed returned HTTP 404/,
  );
});

test("stable and preview users never select alpha releases", () => {
  for (const audience of ["stable", "preview"]) {
    assert.equal(selectDesktopReleaseCandidate(["v99.0.0-alpha.1"], "1.0.0", audience), null);
  }
});
