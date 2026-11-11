import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HarmonyError, defaultHarmonyConfigPath, discoverHdcCandidates, readHarmonyConfig, resolveHarmonyStorage, resolveHdcPath, writeHarmonyConfig } = await jiti.import("./harmony/index.ts");

test("persists only the bundled native video provider", () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-video-config-"));
  const path = join(directory, "harmony.json");
  try {
    writeHarmonyConfig({ video: { provider: "bundled" } }, path);
    assert.deepEqual(readHarmonyConfig(path).video, { provider: "bundled" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy video selections migrate to bundled capture and discard all external paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-video-migration-")), path = join(directory, "harmony.json");
  try {
    for (const provider of ["deveco", "hos-scrcpy", "bundled"]) {
      writeFileSync(path, JSON.stringify({ hdcPath: "C:/hdc.exe", video: { provider, packageDirectory: "C:/external", javaPath: "C:/java.exe" }, storage: { recordingDirectory: "C:/recordings" } }));
      const migrated = readHarmonyConfig(path);
      assert.deepEqual(migrated.video, { provider: "bundled" });
      assert.ok(migrated.hdcPath); assert.ok(migrated.storage.recordingDirectory);
      writeHarmonyConfig(migrated, path);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).video, { provider: "bundled" });
    }
    for (const video of [{ provider: "deveco" }, { provider: "hos-scrcpy", packageDirectory: "C:/external" }, { provider: "bundled", javaPath: "C:/java.exe" }, { provider: "unknown" }]) {
      assert.throws(() => writeHarmonyConfig({ video }, path), error => error.code === "INVALID_ARGUMENT");
      assert.deepEqual(readHarmonyConfig(path).video, { provider: "bundled" }, "rejected writes preserve the valid configuration");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("resolves HDC to an absolute executable in deterministic precedence order", () => {
  const existing = new Set([
    "C:\\explicit\\hdc.exe",
    "C:\\env\\hdc.exe",
    "C:\\cfg\\hdc.exe",
    "C:\\Tools\\hdc.exe",
  ]);
  const common = {
    platform: "win32",
    homeDir: "C:\\Users\\test",
    exists: (path) => existing.has(path),
    listDirectory: () => [],
  };

  assert.deepEqual(resolveHdcPath({
    ...common,
    explicitPath: "C:\\explicit\\hdc.exe",
    env: { PIORA_HARMONY_HDC_PATH: "C:\\env\\hdc.exe", PATH: "C:\\Tools" },
    config: { hdcPath: "C:\\cfg\\hdc.exe" },
  }), { hdcPath: "C:\\explicit\\hdc.exe", source: "explicit" });

  assert.deepEqual(resolveHdcPath({
    ...common,
    env: { PIORA_HARMONY_HDC_PATH: "C:\\env\\hdc.exe", PATH: "C:\\Tools" },
    config: { hdcPath: "C:\\cfg\\hdc.exe" },
  }), { hdcPath: "C:\\env\\hdc.exe", source: "environment" });

  assert.deepEqual(resolveHdcPath({
    ...common,
    env: { PATH: "C:\\Tools" },
    config: { hdcPath: "C:\\cfg\\hdc.exe" },
  }), { hdcPath: "C:\\cfg\\hdc.exe", source: "config" });
});

test("rejects a selected HDC path instead of silently falling through", () => {
  assert.throws(() => resolveHdcPath({
    explicitPath: "C:\\missing\\hdc.exe",
    platform: "win32",
    env: {},
    exists: () => false,
    listDirectory: () => [],
  }), (error) => error instanceof HarmonyError && error.code === "HDC_INVALID");
});

test("uses the application-bundled HDC only after system discovery is exhausted", () => {
  const bundled = "C:\\Piora\\resources\\harmony-tools\\hdc.exe";
  assert.deepEqual(resolveHdcPath({
    platform: "win32",
    homeDir: "C:\\Users\\test",
    env: { PIORA_HARMONY_TOOLS_DIR: "C:\\Piora\\resources\\harmony-tools", PATH: "C:\\Missing" },
    exists: (path) => path === bundled,
    listDirectory: () => [],
  }), { hdcPath: bundled, source: "bundled" });
});

test("discovers a custom DevEco installation through Huawei's local .home metadata", () => {
  const hdc = "G:\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe";
  assert.deepEqual(resolveHdcPath({
    platform: "win32",
    homeDir: "C:\\Users\\test",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    exists: (path) => path === hdc,
    listDirectory: (path) => path === "C:\\Users\\test\\AppData\\Local\\Huawei" ? ["DevEcoStudio2025.1"] : [],
    readTextFile: (path) => {
      assert.equal(path, "C:\\Users\\test\\AppData\\Local\\Huawei\\DevEcoStudio2025.1\\.home");
      return "G:\\DevEco Studio\r\n";
    },
  }), { hdcPath: hdc, source: "deveco" });
});

test("keeps Harmony configuration inside the active desktop profile", () => {
  assert.equal(
    defaultHarmonyConfigPath({ PIORA_DESKTOP_DATA_DIR: "C:\\Piora\\runtime\\device-control", APPDATA: "C:\\Users\\test\\AppData\\Roaming" }),
    "C:\\Piora\\runtime\\device-control\\harmony.json",
  );
  assert.equal(
    defaultHarmonyConfigPath({ PIORA_HARMONY_CONFIG_PATH: "C:\\explicit\\harmony.json", PIORA_DESKTOP_DATA_DIR: "C:\\ignored" }),
    "C:\\explicit\\harmony.json",
  );
});

test("persisted HDC configuration rejects relative executable paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-config-"));
  try {
    assert.throws(
      () => writeHarmonyConfig({ hdcPath: "relative\\hdc.exe" }, join(directory, "harmony.json")),
      (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovers every usable HDC candidate and resolves a user-selected SDK root", () => {
  const existing = new Set([
    "C:\\selected\\6.0.1\\openharmony\\toolchains\\hdc.exe",
    "C:\\env\\hdc.exe",
    "C:\\Tools\\hdc.exe",
  ]);
  const candidates = discoverHdcCandidates({
    selectionPath: "C:\\selected",
    platform: "win32",
    homeDir: "C:\\Users\\test",
    env: { HDC_PATH: "C:\\env\\hdc.exe", PATH: "C:\\Tools" },
    exists: (path) => existing.has(path),
    listDirectory: (path) => path === "C:\\selected" ? ["6.0.1"] : [],
  });
  assert.deepEqual(candidates.map(({ hdcPath, sdkPath, source }) => ({ hdcPath, sdkPath, source })), [
    { hdcPath: "C:\\selected\\6.0.1\\openharmony\\toolchains\\hdc.exe", sdkPath: "C:\\selected\\6.0.1\\openharmony", source: "selection" },
    { hdcPath: "C:\\env\\hdc.exe", sdkPath: "C:\\env", source: "environment" },
    { hdcPath: "C:\\Tools\\hdc.exe", sdkPath: "C:\\Tools", source: "path" },
  ]);
});

test("persists separate vision-model routing without sharing raw screenshots by default", () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-vision-config-"));
  const path = join(directory, "harmony.json");
  try {
    writeHarmonyConfig({ vision: { enabled: true, provider: "openai", modelId: "gpt-5.2" } }, path);
    assert.deepEqual(readHarmonyConfig(path), {
      vision: { enabled: true, provider: "openai", modelId: "gpt-5.2" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists absolute screenshot and recording directories with profile-local defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-storage-config-"));
  const path = join(directory, "harmony.json");
  const screenshotDirectory = join(directory, "shots");
  const recordingDirectory = join(directory, "videos");
  try {
    writeHarmonyConfig({ storage: { screenshotDirectory, recordingDirectory } }, path);
    assert.deepEqual(readHarmonyConfig(path).storage, { screenshotDirectory, recordingDirectory });
    assert.throws(
      () => writeHarmonyConfig({ storage: { screenshotDirectory: "relative" } }, path),
      (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT",
    );
    assert.deepEqual(resolveHarmonyStorage({}, { PIORA_DESKTOP_DATA_DIR: directory }), {
      screenshotDirectory: join(directory, "harmony-media", "screenshots"),
      recordingDirectory: join(directory, "harmony-media", "recordings"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
