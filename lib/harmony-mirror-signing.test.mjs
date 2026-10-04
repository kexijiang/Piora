import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import {
  decryptDevEcoProtectedPassword,
  isDevEcoProtectedPassword,
} from "./harmony/runtime/deveco-password.mjs";

const jiti = createJiti(import.meta.url);
const {
  readVerifiedCachedMirrorHap,
  prepareLocalMirrorHap,
  resolveLocalSigningMaterial,
  resolveSigningTools,
  runWithSigningMaterialRecovery,
  selectDevEcoSigningMaterial,
  validatePublicMirrorReceipt,
} = await jiti.import("./harmony/runtime/mirror-signing.ts");

const COMPONENT = Buffer.from([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119]);
const digest = value => createHash("sha256").update(value).digest("hex");

function encryptContainer(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(encrypted.length + 16);
  return Buffer.concat([header, iv, encrypted, cipher.getAuthTag()]);
}

async function protectedPasswordFixture(root, password) {
  const material = join(root, "material");
  const components = [Buffer.alloc(16, 0x12), Buffer.alloc(16, 0x34), Buffer.alloc(16, 0x56)];
  for (let index = 0; index < components.length; index += 1) {
    const directory = join(material, "fd", `part-${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "value"), components[index]);
  }
  const mixed = Buffer.from(components[0]);
  for (const component of [...components.slice(1), COMPONENT]) {
    for (let index = 0; index < mixed.length; index += 1) mixed[index] ^= component[index];
  }
  const salt = Buffer.from("piora-deveco-password-test-salt", "utf8");
  const workKey = Buffer.alloc(16, 0x7a);
  const rootKey = pbkdf2Sync(mixed.toString(), salt, 10_000, 16, "sha256");
  await mkdir(join(material, "ac"), { recursive: true });
  await mkdir(join(material, "ce"), { recursive: true });
  await writeFile(join(material, "ac", "salt"), salt);
  await writeFile(join(material, "ce", "work-key"), encryptContainer(rootKey, workKey));
  const encrypted = encryptContainer(workKey, Buffer.from(password, "utf8"));
  mixed.fill(0);
  rootKey.fill(0);
  workKey.fill(0);
  return encrypted.toString("hex");
}

test("DevEco protected passwords decrypt exactly and plaintext descriptors are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-password-"));
  try {
    const expected = "test-only-口令-4821";
    const encrypted = await protectedPasswordFixture(root, expected);
    assert.equal(isDevEcoProtectedPassword(encrypted), true);
    assert.equal(await decryptDevEcoProtectedPassword(root, encrypted), expected);
    assert.equal(isDevEcoProtectedPassword(expected), false);
    assert.equal(isDevEcoProtectedPassword("00".repeat(40)), false);
    await assert.rejects(decryptDevEcoProtectedPassword(root, expected), /unsupported shape/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Java signer accepts secrets only over stdin and the desktop package includes its source launcher", () => {
  const wrapperPath = new URL("./harmony/runtime/PioraHapSigner.java", import.meta.url);
  const helperPath = new URL("./harmony/runtime/deveco-password.mjs", import.meta.url);
  const builderPath = new URL("../desktop/electron-builder.yml", import.meta.url);
  const packageVerifierPath = new URL("../scripts/verify-packaged-web.mjs", import.meta.url);
  const wrapper = readFileSync(wrapperPath, "utf8");
  const helper = readFileSync(helperPath, "utf8");
  const builder = readFileSync(builderPath, "utf8");
  const packageVerifier = readFileSync(packageVerifierPath, "utf8");
  assert.match(wrapper, /new InputStreamReader\(System\.in, StandardCharsets\.UTF_8\)/);
  assert.match(wrapper, /keyPassword = readSecret\(reader\)/);
  assert.match(wrapper, /storePassword = readSecret\(reader\)/);
  assert.match(wrapper, /if \(keyPassword != null\) Arrays\.fill\(keyPassword, '\\0'\)/);
  assert.match(wrapper, /if \(storePassword != null\) Arrays\.fill\(storePassword, '\\0'\)/);
  assert.doesNotMatch(wrapper, /keyPassword\s*=\s*args\[/);
  assert.doesNotMatch(wrapper, /storePassword\s*=\s*args\[/);
  const processArguments = helper.slice(helper.indexOf("const args = ["), helper.indexOf("const secretInput"));
  assert.doesNotMatch(processArguments, /keyPassword|storePassword/);
  assert.match(helper, /stdio: \["pipe", "pipe", "pipe"\]/);
  assert.match(builder, /from: \.\.\/lib\/harmony\/runtime\/PioraHapSigner\.java[\s\S]*to: harmony-tools\/PioraHapSigner\.java/);
  assert.match(builder, /from: \.\.\/third_party\/harmony-mirror[\s\S]*to: harmony-tools\/signing-project/);
  assert.match(packageVerifier, /assertFile\(join\(dirname\(packagedWebRoot\), "harmony-tools", "PioraHapSigner\.java"\)\)/);
  assert.match(packageVerifier, /"entry\/src\/main\/module\.json5"/);
  assert.ok(statSync(wrapperPath).size > 500);
});

test("standard DevEco build profiles select exactly one linked HarmonyOS signing material", () => {
  const material = {
    certpath: "C:\\Users\\fixture\\.ohos\\config\\app.cer",
    keyAlias: "debugKey",
    keyPassword: "00".repeat(33),
    profile: "C:\\Users\\fixture\\.ohos\\config\\app.p7b",
    signAlg: "SHA256withECDSA",
    storeFile: "C:\\Users\\fixture\\.ohos\\config\\app.p12",
    storePassword: "00".repeat(33),
  };
  const profile = {
    app: {
      products: [{ name: "default", signingConfig: "default" }],
      signingConfigs: [{ name: "default", type: "HarmonyOS", material }],
    },
  };
  assert.equal(selectDevEcoSigningMaterial(profile), material);
  assert.throws(() => selectDevEcoSigningMaterial({ app: {
    products: [...profile.app.products, ...profile.app.products],
    signingConfigs: profile.app.signingConfigs,
  } }), /ambiguous product/);
  assert.throws(() => selectDevEcoSigningMaterial({ app: {
    products: [{ name: "default", signingConfig: "another" }],
    signingConfigs: profile.app.signingConfigs,
  } }), /does not reference/);
});

test("missing custom descriptor invokes DevEco CLI in a private template copy and imports its generated config", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-auto-signing-"));
  try {
    const home = join(root, "home");
    const config = join(home, ".ohos", "config");
    const cache = join(root, "cache");
    const cliPath = join(root, "runtime", "node_modules", "@deveco", "deveco-cli", "dist", "cli.js");
    const sourceHapPath = join(root, "resources", "harmony-tools", "OHScrcpyServer.hap");
    const templatePath = fileURLToPath(new URL("../third_party/harmony-mirror", import.meta.url));
    const certpath = join(config, "generated.cer");
    const profilePath = join(config, "generated.p7b");
    const storeFile = join(config, "generated.p12");
    const protectedPassword = Buffer.concat([
      Buffer.from([0, 0, 0, 17]),
      Buffer.alloc(12),
      Buffer.alloc(1),
      Buffer.alloc(16),
    ]).toString("hex");
    await Promise.all([
      mkdir(dirname(cliPath), { recursive: true }),
      mkdir(config, { recursive: true }),
      mkdir(dirname(sourceHapPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(cliPath, "fixture DevEco CLI"),
      writeFile(certpath, "fixture certificate"),
      writeFile(profilePath, "fixture profile"),
      writeFile(storeFile, "fixture keystore"),
    ]);
    let command;
    const result = await resolveLocalSigningMaterial({
      cacheDirectory: cache,
      devecoCliPath: cliPath,
      deviceUdid: "a".repeat(64),
      environment: { USERPROFILE: home },
      execute: async options => {
        command = options;
        await writeFile(join(options.cwd, "build-profile.json5"), JSON.stringify({
          app: {
            products: [{ name: "default", compatibleSdkVersion: "26.0.0", signingConfig: "default" }],
            signingConfigs: [{
              name: "default",
              type: "HarmonyOS",
              material: {
                certpath,
                keyAlias: "debugKey",
                keyPassword: protectedPassword,
                profile: profilePath,
                signAlg: "SHA256withECDSA",
                storeFile,
                storePassword: protectedPassword,
              },
            }],
          },
          modules: [{ name: "entry", srcPath: "./entry" }],
        }));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
      },
      runtimeExecutablePath: process.execPath,
      signingTemplatePath: templatePath,
      sourceHapPath,
    });
    assert.deepEqual(command.args, [cliPath, "signature", "generate", "--product", "default"]);
    assert.equal(command.executable, process.execPath);
    assert.equal(command.operation, "generate_local_mirror_signing_profile");
    assert.equal(command.env.DEVECO_CLI_DISABLE_TELEMETRY, "1");
    assert.equal(command.env.DEVECO_CLI_DISABLE_UPDATE, "1");
    assert.match(command.cwd, /deveco-signing-project$/);
    assert.equal(command.args.join(" ").includes("a".repeat(64)), false);
    assert.equal(command.args.join(" ").includes(protectedPassword), false);
    assert.equal(result.material.certpath, certpath);
    assert.equal(result.material.profile, profilePath);
    assert.equal(result.material.storeFile, storeFile);
    assert.match(result.verifiedMarker, /^[\s\S]*[0-9a-f]{64}\.verified$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic DevEco import rejects generated material outside the private config root", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-auto-escape-"));
  try {
    const home = join(root, "home");
    const config = join(home, ".ohos", "config");
    const cache = join(root, "cache");
    const outside = join(root, "outside");
    const cliPath = join(root, "cli.js");
    const sourceHapPath = join(root, "resources", "OHScrcpyServer.hap");
    const templatePath = fileURLToPath(new URL("../third_party/harmony-mirror", import.meta.url));
    const protectedPassword = Buffer.concat([
      Buffer.from([0, 0, 0, 17]), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16),
    ]).toString("hex");
    await Promise.all([mkdir(config, { recursive: true }), mkdir(outside, { recursive: true })]);
    const paths = { certpath: join(outside, "app.cer"), profile: join(outside, "app.p7b"), storeFile: join(outside, "app.p12") };
    await Promise.all([writeFile(cliPath, "fixture CLI"), ...Object.values(paths).map(path => writeFile(path, "fixture"))]);
    await assert.rejects(resolveLocalSigningMaterial({
      cacheDirectory: cache,
      devecoCliPath: cliPath,
      deviceUdid: "b".repeat(64),
      environment: { USERPROFILE: home },
      execute: async options => {
        await writeFile(join(options.cwd, "build-profile.json5"), JSON.stringify({
          app: {
            products: [{ name: "default", signingConfig: "default" }],
            signingConfigs: [{ name: "default", type: "HarmonyOS", material: {
              ...paths, keyAlias: "debugKey", keyPassword: protectedPassword,
              signAlg: "SHA256withECDSA", storePassword: protectedPassword,
            } }],
          },
          modules: [{ name: "entry", srcPath: "./entry" }],
        }));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
      },
      signingTemplatePath: templatePath,
      sourceHapPath,
    }), /leaves the config directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit private descriptor remains a strict non-generating override", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-descriptor-"));
  try {
    const home = join(root, "home");
    const config = join(home, ".ohos", "config");
    const certpath = join(config, "existing.cer");
    const profilePath = join(config, "existing.p7b");
    const storeFile = join(config, "existing.p12");
    const descriptorPath = join(config, "configured.json");
    const protectedPassword = Buffer.concat([
      Buffer.from([0, 0, 0, 17]), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16),
    ]).toString("hex");
    await mkdir(config, { recursive: true });
    await Promise.all([
      writeFile(certpath, "fixture certificate"),
      writeFile(profilePath, "fixture profile"),
      writeFile(storeFile, "fixture keystore"),
      writeFile(descriptorPath, JSON.stringify({
        schemaVersion: 1,
        name: "pioraHarmonyDevice",
        type: "HarmonyOS",
        material: {
          certpath,
          keyAlias: "debugKey",
          keyPassword: protectedPassword,
          profile: profilePath,
          signAlg: "SHA256withECDSA",
          storeFile,
          storePassword: protectedPassword,
        },
      })),
    ]);
    const result = await resolveLocalSigningMaterial({
      cacheDirectory: join(root, "cache"),
      descriptorPath,
      deviceUdid: "c".repeat(64),
      environment: { USERPROFILE: home },
      execute: async () => { throw new Error("explicit descriptors must not invoke DevEco CLI"); },
      sourceHapPath: join(root, "missing-public.hap"),
    });
    assert.equal(result.material.certpath, certpath);
    assert.equal(result.material.profile, profilePath);
    assert.equal(result.verifiedMarker, undefined);
    await assert.rejects(resolveLocalSigningMaterial({
      cacheDirectory: join(root, "cache"),
      descriptorPath: join(config, "missing.json"),
      deviceUdid: "c".repeat(64),
      environment: { USERPROFILE: home },
      execute: async () => { throw new Error("must not fall back"); },
      sourceHapPath: join(root, "missing-public.hap"),
    }), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed packaged signing template refreshes the private project and rechecks the device profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-template-refresh-"));
  try {
    const home = join(root, "home");
    const config = join(home, ".ohos", "config");
    const cache = join(root, "cache");
    const templatePath = join(root, "template");
    const sourceTemplate = fileURLToPath(new URL("../third_party/harmony-mirror", import.meta.url));
    const cliPath = join(root, "cli.js");
    const certpath = join(config, "generated.cer");
    const profilePath = join(config, "generated.p7b");
    const storeFile = join(config, "generated.p12");
    const protectedPassword = Buffer.concat([
      Buffer.from([0, 0, 0, 17]), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16),
    ]).toString("hex");
    await cp(sourceTemplate, templatePath, { recursive: true });
    await mkdir(config, { recursive: true });
    await Promise.all([
      writeFile(cliPath, "fixture CLI"),
      writeFile(certpath, "fixture certificate"),
      writeFile(profilePath, "fixture profile"),
      writeFile(storeFile, "fixture keystore"),
    ]);
    let calls = 0;
    const seenVersions = [];
    const execute = async options => {
      calls++;
      const appScope = JSON.parse(await readFile(join(options.cwd, "AppScope", "app.json5"), "utf8"));
      seenVersions.push(appScope.app.versionName);
      await writeFile(join(options.cwd, "build-profile.json5"), JSON.stringify({
        app: {
          products: [{ name: "default", signingConfig: "default" }],
          signingConfigs: [{ name: "default", type: "HarmonyOS", material: {
            certpath, keyAlias: "debugKey", keyPassword: protectedPassword, profile: profilePath,
            signAlg: "SHA256withECDSA", storeFile, storePassword: protectedPassword,
          } }],
        },
        modules: [{ name: "entry", srcPath: "./entry" }],
      }));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    };
    const base = {
      cacheDirectory: cache,
      devecoCliPath: cliPath,
      deviceUdid: "d".repeat(64),
      environment: { USERPROFILE: home },
      execute,
      signingTemplatePath: templatePath,
      sourceHapPath: join(root, "resources", "OHScrcpyServer.hap"),
    };
    const first = await resolveLocalSigningMaterial(base);
    const firstFingerprint = await readFile(join(cache, "deveco-signing-project", ".piora-template-sha256"), "utf8");
    await mkdir(dirname(first.verifiedMarker), { recursive: true });
    await writeFile(first.verifiedMarker, "piora-device-profile-v1\n");
    const appPath = join(templatePath, "AppScope", "app.json5");
    const updatedApp = JSON.parse(await readFile(appPath, "utf8"));
    updatedApp.app.versionName = "1.1.28-test";
    await writeFile(appPath, `${JSON.stringify(updatedApp, null, 2)}\n`);
    await resolveLocalSigningMaterial(base);
    const secondFingerprint = await readFile(join(cache, "deveco-signing-project", ".piora-template-sha256"), "utf8");
    assert.equal(calls, 2, "template refresh removes the old per-device verification marker");
    assert.deepEqual(seenVersions, ["1.1.27", "1.1.28-test"]);
    assert.notEqual(firstFingerprint, secondFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later signing or official verification failure invalidates the generated device marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-deveco-marker-recovery-"));
  try {
    const marker = join(root, ".piora-device-profiles", `${"e".repeat(64)}.verified`);
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "piora-device-profile-v1\n");
    await assert.rejects(runWithSigningMaterialRecovery(marker, async () => {
      throw new Error("official profile verification failed");
    }), /official profile verification failed/);
    await assert.rejects(readFile(marker), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function publicReceipt(source) {
  const publicSha256 = digest(source);
  const acceptedSha256 = digest(Buffer.concat([source, Buffer.from("private acceptance")]));
  return {
    schemaVersion: 2,
    kind: "private-device-acceptance-verification",
    origin: { repository: "owner/repository" },
    artifact: { filename: "OHScrcpyServer.hap", size: source.length, sha256: publicSha256 },
    acceptanceArtifact: { size: source.length + 1, sha256: acceptedSha256, sourceSha256: publicSha256 },
    sdk: {
      apiVersion: "26", platformVersion: "26.0.0", toolVersion: "26.0.0.17",
      releaseType: "Release", signToolSha256: digest("sign tool"),
    },
    signing: {
      mode: "localSign", material: "private DevEco acceptance identity", alias: "debugKey",
      profileType: "debug", compatibleVersion: 26, signCode: true,
      distribution: "public artifact remains unsigned",
    },
    verification: { verifyApp: true, verifyProfile: true },
    deviceAcceptance: { passed: true, acceptedHapSha256: acceptedSha256 },
  };
}

test("runtime receipt validation binds private acceptance to the exact public unsigned HAP", () => {
  const source = Buffer.from("unsigned-hap-fixture");
  const valid = publicReceipt(source);
  assert.doesNotThrow(() => validatePublicMirrorReceipt(valid, source));
  for (const mutate of [
    receipt => { receipt.acceptanceArtifact.sourceSha256 = digest("different source"); },
    receipt => { receipt.signing.distribution = "device-bound HAP is public"; },
    receipt => { receipt.deviceAcceptance.acceptedHapSha256 = digest("different HAP"); },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validatePublicMirrorReceipt(invalid, source), /release receipt/);
  }
});

test("private mirror cache is bound to a device digest and cryptographically reverified on every hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-mirror-cache-"));
  try {
    const cacheHap = join(root, "mirror.hap");
    const cacheReceipt = `${cacheHap}.json`;
    const bytes = Buffer.from("signed-private-hap");
    const expected = {
      publicSha256: digest("public"),
      materialSha256: digest("material"),
      deviceSha256: digest("device-a"),
    };
    await writeFile(cacheHap, bytes);
    await writeFile(cacheReceipt, JSON.stringify({ schemaVersion: 1, ...expected, signedSha256: digest(bytes) }));
    let verifications = 0;
    assert.equal(await readVerifiedCachedMirrorHap(cacheHap, cacheReceipt, expected, async path => {
      verifications++;
      assert.equal(path, cacheHap);
    }), cacheHap);
    assert.equal(verifications, 1);
    assert.equal(await readVerifiedCachedMirrorHap(cacheHap, cacheReceipt,
      { ...expected, deviceSha256: digest("device-b") }, async () => { verifications++; }), undefined);
    assert.equal(verifications, 1, "a cache receipt for another phone is rejected before verification");
    assert.equal(await readVerifiedCachedMirrorHap(cacheHap, cacheReceipt, expected,
      async () => { throw new Error("profile no longer verifies"); }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime signing finds API 26 from DEVECO_SDK_HOME even when Piora uses its bundled HDC", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-signing-tools-"));
  try {
    const sdkHome = join(root, "sdk");
    const sdkDefault = join(sdkHome, "default");
    const toolchains = join(sdkDefault, "openharmony", "toolchains");
    const studioHome = join(root, "studio");
    const javaPath = join(studioHome, "jbr", "bin", process.platform === "win32" ? "java.exe" : "java");
    const hdcPath = join(root, "packaged", process.platform === "win32" ? "hdc.exe" : "hdc");
    const signerSource = join(root, "packaged", "PioraHapSigner.java");
    await Promise.all([
      mkdir(dirname(javaPath), { recursive: true }),
      mkdir(join(toolchains, "lib"), { recursive: true }),
      mkdir(dirname(hdcPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sdkDefault, "sdk-pkg.json"), JSON.stringify({ data: { apiVersion: "26", platformVersion: "26.0.0" } })),
      writeFile(join(toolchains, "lib", "hap-sign-tool.jar"), "fixture-sign-tool"),
      writeFile(javaPath, "fixture-java"),
      writeFile(hdcPath, "fixture-bundled-hdc"),
      writeFile(signerSource, "class PioraHapSigner {}"),
    ]);
    const tools = await resolveSigningTools(hdcPath, {
      DEVECO_SDK_HOME: sdkHome,
      DEVECO_STUDIO_HOME: studioHome,
      PIORA_HARMONY_SIGNER_SOURCE_PATH: signerSource,
    });
    assert.equal(tools.java, javaPath);
    assert.equal(tools.signTool, join(toolchains, "lib", "hap-sign-tool.jar"));
    assert.equal(tools.signerSource, signerSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled local signing request preserves COMMAND_ABORTED semantics", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareLocalMirrorHap({
    sourceHapPath: join(tmpdir(), "missing-public-mirror.hap"),
    hdcPath: join(tmpdir(), "missing-hdc"),
    deviceUdid: "a".repeat(64),
    cacheDirectory: join(tmpdir(), "unused-private-cache"),
    signal: controller.signal,
  }), error => error?.code === "COMMAND_ABORTED" && error?.details?.dispatchState === "not-sent");
});
