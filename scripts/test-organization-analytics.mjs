import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const require = createRequire(import.meta.url),
  repo = resolve(import.meta.dirname, "..");
if (!process.versions.electron) {
  const root = mkdtempSync(join(tmpdir(), "piora-analytics-native-")),
    env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [import.meta.filename, root], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    clearTimeout(timeout);
    assert.match(
      relative(resolve(tmpdir()), resolve(root)),
      /^piora-analytics-native-[\w-]+$/,
    );
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
} else {
  void native().catch((e) => {
    console.error(e);
    require("electron").app.exit(1);
  });
}
async function native() {
  const { app, safeStorage, powerMonitor } = require("electron"),
    root = process.argv[2];
  assert.match(
    relative(resolve(tmpdir()), resolve(root)),
    /^piora-analytics-native-[\w-]+$/,
  );
  app.setPath("userData", join(root, "profile"));
  await app.whenReady();
  for (const name of [
    "analytics-store",
    "analytics-uploader",
    "analytics-desktop",
  ]) {
    const source = readFileSync(
      join(repo, "desktop/src", name + ".mts"),
      "utf8",
    );
    writeFileSync(
      join(root, name + ".mjs"),
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
  }
  // Electron's ESM API is exposed through its Node module resolver, not a copied dependency tree.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const { AnalyticsStore } = await import(
    pathToFileURL(join(root, "analytics-store.mjs"))
  );
  const { AnalyticsUploader } = await import(
    pathToFileURL(join(root, "analytics-uploader.mjs"))
  );
  const store = new AnalyticsStore(join(root, "outbox"));
  store.set("app_version", "native-fixture");
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
  const text = "native-dpapi-test-" + Date.now(),
    encrypted = await safeStorage.encryptStringAsync(text);
  assert.equal((await safeStorage.decryptStringAsync(encrypted)).result, text);
  assert(!encrypted.includes(Buffer.from(text)));
  const uploader = await AnalyticsUploader.create(
    store,
    {
      enabled: true,
      backend_url: "https://analytics.example.test",
      enrollment_key: "fixture",
    },
    safeStorage,
    async () => {
      throw Error("Network is intentionally excluded from this fixture");
    },
  );
  const bytes = readFileSync(join(store.directory, "credentials.dpapi"));
  assert(!bytes.toString().includes("credential_id"));
  assert.equal(
    JSON.parse((await safeStorage.decryptStringAsync(bytes)).result)
      .registration.installation_id,
    store.installationId,
  );
  assert(Number.isFinite(powerMonitor.getSystemIdleTime()));
  const { DesktopAnalytics } = await import(
    pathToFileURL(join(root, "analytics-desktop.mjs"))
  );
  const desktop = new DesktopAnalytics(store, uploader, () => null);
  await new Promise((r) => setTimeout(r, 30));
  powerMonitor.emit("lock-screen");
  await new Promise((r) => setTimeout(r, 30));
  powerMonitor.emit("unlock-screen");
  powerMonitor.emit("suspend");
  await new Promise((r) => setTimeout(r, 30));
  powerMonitor.emit("resume");
  desktop.stop();
  const events = store.db
    .prepare("SELECT json FROM outbox")
    .all()
    .map((r) => JSON.parse(r.json));
  assert.equal(
    events.filter((e) => e.event_type === "desktop.started").length,
    1,
  );
  assert(
    events.some(
      (e) =>
        e.event_type === "desktop.activity" && Number(e.payload.runtime_ms) > 0,
    ),
  );
  assert(
    events
      .filter((e) => e.event_type === "desktop.activity")
      .every((e) => e.payload.active_ranges.length === 0),
  );
  uploader.stop();
  store.close();
  console.log(
    "PASS: real Electron SQLite WAL, Windows DPAPI credential round-trip, powerMonitor availability. No model/provider or installed-package test.",
  );
  app.exit(0);
}
