import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createIsolatedProcessEnvironment,
  getIsolatedEnvironmentPaths,
} from "../scripts/isolated-process-env.mjs";
import { verifyReleaseMetadata } from "../scripts/verify-release-metadata.mjs";
import {
  DEFAULT_PORTABLE_SMOKE_TIMEOUT_MS,
  LINUX_PACKAGED_RUNTIME_STARTUP_MS,
  MAX_PORTABLE_STARTUP_MS,
  PACKAGED_RUNTIME_STARTUP_MS,
  findPortableExecutable,
  getPackagedRuntimeStartupBudget,
  getPortableDisplayEnvironment,
  normalizeExpectedVersion,
  validatePortableSmokeMarker,
  validateStartupMarker,
} from "../scripts/smoke-test-portable.mjs";
import { findSymbolicLinks } from "../scripts/stage-standalone.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("release metadata requires an exact tag, matching package versions, and changelog heading", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-release-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "desktop"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"version":"1.2.3"}\n', "utf8"),
    writeFile(join(root, "desktop", "package.json"), '{"version":"1.2.3"}\n', "utf8"),
    writeFile(
      join(root, "package-lock.json"),
      '{"version":"1.2.3","packages":{"":{"version":"1.2.3"},"desktop":{"version":"1.2.3"}}}\n',
      "utf8",
    ),
    writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3] - 2026-08-01\n", "utf8"),
  ]);

  assert.deepEqual(
    await verifyReleaseMetadata({ projectRoot: root, tagName: "v1.2.3" }),
    {
      tagName: "v1.2.3",
      version: "1.2.3",
      rootVersion: "1.2.3",
      desktopVersion: "1.2.3",
      commit: null,
    },
  );
  await assert.rejects(
    verifyReleaseMetadata({ projectRoot: root, tagName: "v1.2.3-beta.1" }),
    /exactly match vX\.Y\.Z/,
  );
  await writeFile(join(root, "desktop", "package.json"), '{"version":"1.2.4"}\n', "utf8");
  await assert.rejects(
    verifyReleaseMetadata({ projectRoot: root, tagName: "v1.2.3" }),
    /must match both package versions/,
  );
  await writeFile(join(root, "desktop", "package.json"), '{"version":"1.2.3"}\n', "utf8");
  await writeFile(
    join(root, "package-lock.json"),
    '{"version":"1.2.3","packages":{"":{"version":"1.2.3"},"desktop":{"version":"1.2.4"}}}\n',
    "utf8",
  );
  await assert.rejects(
    verifyReleaseMetadata({ projectRoot: root, tagName: "v1.2.3" }),
    /must match package-lock versions/,
  );
});

test("preview release metadata accepts only matching beta tags", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-preview-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "desktop"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"version":"1.3.0-beta.2"}\n', "utf8"),
    writeFile(join(root, "desktop", "package.json"), '{"version":"1.3.0-beta.2"}\n', "utf8"),
    writeFile(
      join(root, "package-lock.json"),
      '{"version":"1.3.0-beta.2","packages":{"":{"version":"1.3.0-beta.2"},"desktop":{"version":"1.3.0-beta.2"}}}\n',
      "utf8",
    ),
    writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.3.0-beta.2] - 2026-09-01\n", "utf8"),
  ]);

  assert.equal((await verifyReleaseMetadata({
    projectRoot: root,
    tagName: "v1.3.0-beta.2",
    prerelease: true,
  })).version, "1.3.0-beta.2");
  await assert.rejects(
    verifyReleaseMetadata({ projectRoot: root, tagName: "v1.3.0-alpha.2", prerelease: true }),
    /must exactly match vX\.Y\.Z-beta\.N/,
  );
});

test("release metadata requires the checked-out tag commit to belong to origin/main", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-release-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "desktop"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"version":"2.0.0"}\n', "utf8"),
    writeFile(join(root, "desktop", "package.json"), '{"version":"2.0.0"}\n', "utf8"),
    writeFile(
      join(root, "package-lock.json"),
      '{"version":"2.0.0","packages":{"":{"version":"2.0.0"},"desktop":{"version":"2.0.0"}}}\n',
      "utf8",
    ),
    writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [2.0.0]\n", "utf8"),
  ]);
  const git = (...arguments_) => {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git("init", "--initial-branch=main");
  git("-c", "user.name=Piora tests", "-c", "user.email=tests@example.invalid", "add", ".");
  git(
    "-c",
    "user.name=Piora tests",
    "-c",
    "user.email=tests@example.invalid",
    "commit",
    "-m",
    "release",
  );
  git("tag", "v2.0.0");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await verifyReleaseMetadata({ projectRoot: root, tagName: "v2.0.0", requireOriginMain: true });

  await writeFile(join(root, "after-main.txt"), "not on origin/main\n", "utf8");
  git("add", "after-main.txt");
  git(
    "-c",
    "user.name=Piora tests",
    "-c",
    "user.email=tests@example.invalid",
    "commit",
    "-m",
    "not on main",
  );
  git("tag", "--force", "v2.0.0");
  await assert.rejects(
    verifyReleaseMetadata({ projectRoot: root, tagName: "v2.0.0", requireOriginMain: true }),
    /does not point to a commit contained in origin\/main/,
  );
});

test("isolated verification environment does not inherit credentials, proxies, Codex, or npm state", () => {
  const root = join(tmpdir(), "piora-isolated-env-test");
  const environment = createIsolatedProcessEnvironment(
    root,
    { NODE_ENV: "production" },
    {
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      SECRET_TOKEN: "do-not-copy",
      GH_TOKEN: "do-not-copy",
      HTTPS_PROXY: "http://secret-proxy.invalid",
      CODEX_HOME: "C:\\private-codex",
      NODE_OPTIONS: "--require C:\\private.js",
      NPM_CONFIG_USERCONFIG: "C:\\private.npmrc",
    },
  );
  const paths = getIsolatedEnvironmentPaths(root);

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.HOME, paths.home);
  assert.equal(environment.APPDATA, paths.appData);
  assert.equal(environment.NPM_CONFIG_USERCONFIG, paths.npmUserConfig);
  for (const forbidden of [
    "SECRET_TOKEN",
    "GH_TOKEN",
    "HTTPS_PROXY",
    "CODEX_HOME",
    "NODE_OPTIONS",
  ]) {
    assert.equal(environment[forbidden], undefined, `${forbidden} must not be inherited`);
  }
});

test("Linux portable smoke tests forward only the Xvfb display contract", () => {
  const hostEnvironment = {
    DISPLAY: ":99",
    XAUTHORITY: "/tmp/xvfb.auth",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/dbus",
    SECRET_TOKEN: "do-not-copy",
  };
  assert.deepEqual(getPortableDisplayEnvironment(hostEnvironment, "linux"), {
    DISPLAY: ":99",
    XAUTHORITY: "/tmp/xvfb.auth",
  });
  assert.deepEqual(getPortableDisplayEnvironment(hostEnvironment, "win32"), {});
});

test("packaged Linux runtime allows CI startup after its service cold start", () => {
  assert.equal(getPackagedRuntimeStartupBudget("linux"), LINUX_PACKAGED_RUNTIME_STARTUP_MS);
  assert.equal(getPackagedRuntimeStartupBudget("win32"), PACKAGED_RUNTIME_STARTUP_MS);
  assert.ok(LINUX_PACKAGED_RUNTIME_STARTUP_MS > PACKAGED_RUNTIME_STARTUP_MS);
  assert.ok(LINUX_PACKAGED_RUNTIME_STARTUP_MS <= 30_000);
});

test("standalone staging detects symbolic links in public assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-public-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target.txt");
  const linked = join(root, "linked.txt");
  await writeFile(target, "safe target\n", "utf8");
  try {
    await symlink(target, linked, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Creating symbolic links is not permitted for this Windows account");
      return;
    }
    throw error;
  }
  assert.deepEqual(await findSymbolicLinks(root), [linked]);
});

test("portable smoke-test selector accepts exactly one named portable executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-portable-selector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "Piora-0.1.0-win-x64-portable.exe");
  await writeFile(executable, "fixture", "utf8");
  assert.equal(await findPortableExecutable(root), executable);
  await writeFile(join(root, "Piora-0.1.1-win-x64-portable.exe"), "fixture", "utf8");
  await assert.rejects(findPortableExecutable(root), /Expected exactly one portable EXE/);
});

test("portable smoke timeout allows first-run extraction and cleanup on Windows", () => {
  assert.equal(DEFAULT_PORTABLE_SMOKE_TIMEOUT_MS, 900_000);
});

test("portable smoke marker requires the expected version and a ready renderer shell", () => {
  assert.equal(MAX_PORTABLE_STARTUP_MS, 3_000);
  assert.equal(validateStartupMarker('{"schema":"piora-startup-v1","ready":true,"surface":"electron-shell"}').ready, true);
  assert.equal(validateStartupMarker('{\u0000"\u0000s\u0000c\u0000h\u0000e\u0000m\u0000a\u0000"\u0000:\u0000"\u0000p\u0000i\u0000o\u0000r\u0000a\u0000-\u0000s\u0000t\u0000a\u0000r\u0000t\u0000u\u0000p\u0000-\u0000v\u00001\u0000"\u0000,\u0000"\u0000r\u0000e\u0000a\u0000d\u0000y\u0000"\u0000:\u0000t\u0000r\u0000u\u0000e\u0000,\u0000"\u0000s\u0000u\u0000r\u0000f\u0000a\u0000c\u0000e\u0000"\u0000:\u0000"\u0000p\u0000o\u0000r\u0000t\u0000a\u0000b\u0000l\u0000e\u0000-\u0000s\u0000p\u0000l\u0000a\u0000s\u0000h\u0000"\u0000}\u0000').surface, "portable-splash");
  assert.throws(() => validateStartupMarker('{"schema":"piora-startup-v1","ready":false,"surface":"electron-shell"}'), /invalid startup marker/);
  assert.throws(() => validateStartupMarker('{"schema":"piora-startup-v1","ready":true,"surface":"unknown"}'), /invalid startup marker/);
  const validMarker = JSON.stringify({
    schema: "piora-portable-smoke-v1",
    ok: true,
    appVersion: "0.1.0",
    rendererLoaded: true,
    preloadBridgeReady: true,
    appShellReady: true,
  });
  assert.equal(normalizeExpectedVersion("v0.1.0"), "0.1.0");
  assert.equal(validatePortableSmokeMarker(validMarker, "v0.1.0").appVersion, "0.1.0");
  assert.throws(
    () => validatePortableSmokeMarker(validMarker, "0.1.1"),
    /does not match expected version/,
  );
  assert.throws(
    () => validatePortableSmokeMarker(JSON.stringify({
      ...JSON.parse(validMarker),
      preloadBridgeReady: false,
    }), "0.1.0"),
    /invalid smoke-test marker/,
  );
  assert.throws(() => normalizeExpectedVersion("0.1"), /must match X\.Y\.Z/);
  assert.equal(normalizeExpectedVersion("v0.2.0-beta.3"), "0.2.0-beta.3");
});

test("portable packaging provides a pre-extraction startup surface", async () => {
  const config = await readFile(join(repositoryRoot, "desktop", "electron-builder.yml"), "utf8");
  const portableTemplate = await readFile(join(repositoryRoot, "desktop", "build", "portable-cache.nsi"), "utf8");
  const splash = await stat(join(repositoryRoot, "desktop", "build", "portable-splash.bmp"));
  assert.match(config, /portable:\s*[\s\S]*splashImage:\s*build\/portable-splash\.bmp/);
  assert.match(config, /^compression:\s*normal$/m);
  assert.match(config, /electronLanguages:\s*\n\s+- en-US\s*\n\s+- zh-CN/);
  assert.match(portableTemplate, /CreateMutexW/);
  assert.match(portableTemplate, /IfFileExists "\$INSTDIR\\\.piora-runtime-ready"/);
  assert.match(portableTemplate, /FileWrite \$0 "\$\{VERSION\}"/);
  assert.ok(splash.isFile() && splash.size > 1_000, "portable splash must be a non-empty BMP asset");
});

test("release workflows use immutable actions and gate the packaged runtime before publication", async () => {
  const [
    releaseWorkflow,
    harmonyWorkflow,
    ciWorkflow,
    rootPackage,
    desktopPackage,
    desktopMain,
    packagedVerifier,
    serviceWorker,
    pwaRegistration,
    appErrorBoundary,
    globalErrorBoundary,
  ] = await Promise.all([
    readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "harmony-preview.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "desktop", "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "desktop", "src", "main.ts"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "verify-packaged-web.mjs"), "utf8"),
    readFile(join(repositoryRoot, "public", "sw.js"), "utf8"),
    readFile(join(repositoryRoot, "components", "PwaRegistration.tsx"), "utf8"),
    readFile(join(repositoryRoot, "app", "error.tsx"), "utf8"),
    readFile(join(repositoryRoot, "app", "global-error.tsx"), "utf8"),
  ]);

  for (const workflow of [releaseWorkflow, harmonyWorkflow, ciWorkflow]) {
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+)/gm)];
    assert.ok(actionReferences.length > 0);
    for (const reference of actionReferences) assert.match(reference[1], /^[0-9a-f]{40}$/);
  }

  assert.match(releaseWorkflow, /windows-build:[\s\S]*?permissions:\s*\n\s+contents: read/);
  assert.match(releaseWorkflow, /source-gate:[\s\S]*?runs-on: ubuntu-latest/);
  assert.match(releaseWorkflow, /windows-build:[\s\S]*?needs: source-gate/);
  assert.match(releaseWorkflow, /linux-build:[\s\S]*?runs-on: ubuntu-latest/);
  assert.match(releaseWorkflow, /linux-build:[\s\S]*?needs: source-gate/);
  assert.match(releaseWorkflow, /npm run dist:linux/);
  assert.match(releaseWorkflow, /linux-unpacked\/resources\/web --require-electron-shell/);
  assert.match(releaseWorkflow, /squashfs-root\/AppRun --expected-version "\$GITHUB_REF_NAME" --packaged-runtime/);
  assert.match(releaseWorkflow, /\*-linux-x64-portable\.AppImage/);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  assert.match(releaseWorkflow, /persist-credentials: false/);
  assert.match(releaseWorkflow, /--require-origin-main/);
  assert.match(
    releaseWorkflow,
    /node scripts\/smoke-test-portable\.mjs desktop\/release\/win-unpacked\/Piora\.exe --expected-version "\$env:GITHUB_REF_NAME" --packaged-runtime/,
  );
  assert.match(releaseWorkflow, /Compress-Archive[\s\S]*Piora-\$version-win-x64\.zip/);
  assert.match(releaseWorkflow, /7z t \$archive/);
  assert.match(releaseWorkflow, /resources\/web\/server\.js/);
  assert.match(releaseWorkflow, /desktop\/release\/\*-win-x64\.zip/);
  assert.match(
    harmonyWorkflow,
    /node scripts\/smoke-test-portable\.mjs desktop\/release\/win-unpacked\/Piora\.exe --expected-version \$env:GITHUB_REF_NAME --packaged-runtime/,
  );
  assert.match(harmonyWorkflow, /node scripts\/verify-portable-artifact\.mjs --expected-version \$env:GITHUB_REF_NAME/);
  assert.match(harmonyWorkflow, /7z t \$artifact\[0\]\.FullName/);
  assert.match(harmonyWorkflow, /Install and smoke-test preview installer/);
  assert.match(harmonyWorkflow, /beta\.yml/);
  const windowsBuildJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  windows-build:"),
    releaseWorkflow.indexOf("  publish-release:"),
  );
  for (const command of [
    "npm run licenses:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run verify:backgrounds",
  ]) {
    const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      windowsBuildJob,
      new RegExp(`- name: [^\\n]+\\n\\s+run: ${escapedCommand}(?:\\r?\\n|$)`),
      `${command} must be a separate fail-fast Windows workflow step`,
    );
  }
  assert.match(releaseWorkflow, /publish-release:[\s\S]*?permissions:\s*\n\s+contents: write/);
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  publish-release:"));
  assert.doesNotMatch(publishJob, /actions\/checkout|npm (?:ci|install|run)/);
  assert.match(publishJob, /--latest/);
  assert.match(publishJob, /Stable desktop release/);
  assert.match(publishJob, /Piora-\$version-linux-x64-portable\.AppImage/);
  assert.doesNotMatch(publishJob, /--prerelease/);
  assert.doesNotMatch(publishJob, /--draft/);
  assert.match(ciWorkflow, /persist-credentials: false/);

  assert.equal(rootPackage.author.name, "Piora contributors");
  assert.equal(desktopPackage.author.name, "Piora contributors");
  assert.equal(rootPackage.publisher, "Piora");
  assert.equal(desktopPackage.publisher, "Piora");
  assert.equal(desktopPackage.productName, "Piora");
  assert.equal(rootPackage.version, desktopPackage.version);
  assert.match(desktopPackage.scripts.pack, /--publish never$/);
  assert.match(desktopPackage.scripts.dist, /--publish never$/);
  assert.match(desktopPackage.scripts["dist:linux"], /--linux AppImage --x64 --publish never$/);
  assert.match(desktopMain, /setAppUserModelId\("io\.github\.kexijiang\.piora"\)/);
  assert.match(desktopMain, /setPath\("userData", join\(app\.getPath\("appData"\), "Piora"\)\)/);
  assert.match(
    desktopMain,
    /if \(PORTABLE_SMOKE_TEST && requestedSmokeUserData\) \{[\s\S]*?setPath\("userData", resolve\(requestedSmokeUserData\)\);[\s\S]*?\} else \{[\s\S]*?app\.getPath\("appData"\)/,
  );
  assert.match(desktopMain, /piora-portable-smoke-v1/);
  assert.match(desktopMain, /PORTABLE_SMOKE_TEST \|\| app\.requestSingleInstanceLock\(\)/);
  assert.match(
    desktopMain,
    /clearStorageData\(\{[\s\S]*?storages: \["serviceworkers", "cachestorage"\][\s\S]*?\}\)/,
  );
  assert.match(desktopMain, /await clearObsoleteDesktopWebCaches\(logger\)/);
  assert.match(desktopMain, /installRendererDiagnostics\(window, "Main", log\)/);
  assert.match(desktopMain, /installRendererDiagnostics\(window, "Companion", log\)/);
  assert.match(packagedVerifier, /electronShell\.executablePath \?\? process\.execPath/);
  assert.match(packagedVerifier, /ELECTRON_RUN_AS_NODE: "1"/);
  assert.match(serviceWorker, /CACHE_PREFIX = "piora"/);
  assert.match(pwaRegistration, /if \(window\.piDesktop\)/);
  assert.match(pwaRegistration, /getRegistrations\(\)/);
  assert.match(pwaRegistration, /registration\.unregister\(\)/);
  assert.match(appErrorBoundary, /RuntimeErrorScreen/);
  assert.match(globalErrorBoundary, /<html lang="zh-CN">/);
  assert.match(
    await readFile(join(repositoryRoot, "desktop", "electron-builder.yml"), "utf8"),
    /beforeBuild:\s*\.\.\/scripts\/electron-before-build\.cjs/,
  );
  assert.match(packagedVerifier, /"electron"/);
  assert.match(packagedVerifier, /"@electron\/get"/);
});

test("standalone staging includes every Next.js server chunk", async () => {
  const source = await readFile(resolve("scripts/stage-standalone.mjs"), "utf8");
  assert.match(source, /name: "Next\.js server chunks"/);
  assert.match(source, /source: join\(nextDirectory, "server", "chunks"\)/);
  assert.match(source, /destination: join\(standaloneDirectory, "\.next", "server", "chunks"\)/);
});

test("release lockfile uses the official npm registry with integrity-pinned artifacts", async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const packages = Object.entries(lock.packages ?? {});
  assert.ok(packages.length > 1_000, "the release lockfile must contain the complete dependency graph");

  const integrityProtectedByShrinkwrapParent = (installPath) => {
    const segments = installPath.split("/node_modules/");
    for (let index = segments.length - 1; index > 0; index -= 1) {
      const parentPath = segments.slice(0, index).join("/node_modules/");
      const parent = lock.packages[parentPath];
      if (parent?.hasShrinkwrap === true) {
        return /^https:\/\/registry\.npmjs\.org\//.test(parent.resolved ?? "")
          && /^sha512-/.test(parent.integrity ?? "");
      }
    }
    return false;
  };

  for (const [installPath, metadata] of packages) {
    if (typeof metadata.resolved !== "string" || !metadata.resolved.startsWith("https://")) continue;
    assert.match(
      metadata.resolved,
      /^https:\/\/registry\.npmjs\.org\//,
      `${installPath} must not depend on an alternate registry`,
    );
    assert.ok(
      /^sha512-/.test(metadata.integrity ?? "") || integrityProtectedByShrinkwrapParent(installPath),
      `${installPath} must be integrity-pinned directly or by its shrinkwrapped parent artifact`,
    );
  }

  assert.equal(lock.packages["node_modules/postcss"]?.version, "8.5.26");
  assert.equal(lock.packages["node_modules/mermaid"]?.version, "11.16.1");
  assert.equal(lock.packages["node_modules/dompurify"]?.version, "3.4.13");
  assert.equal(lock.packages["node_modules/nanoid"]?.version, "3.3.18");
  assert.equal(lock.packages["node_modules/undici"]?.version, "8.9.0");
  assert.notEqual(lock.packages["node_modules/mermaid"]?.dev, true);
});
