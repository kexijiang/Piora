import { createHash, X509Certificate } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import JSON5 from "json5";

import { HarmonyError, isHarmonyError } from "../errors";
import { runCommand, type CommandExecutor } from "../command-runner";
import { previewHapArtifact } from "./hap-preview";
import {
  decryptDevEcoProtectedPassword,
  isDevEcoProtectedPassword,
  signHapWithJava,
} from "./deveco-password.mjs";

const MIRROR_BUNDLE = "com.ohos.scrcpy.server";
const SIGNING_DESCRIPTOR = "piora-harmony-device-signing.json";
const SIGNER_SOURCE = "PioraHapSigner.java";
const SIGNING_PROJECT = "deveco-signing-project";
const SIGNING_TEMPLATE_FINGERPRINT = ".piora-template-sha256";
const SIGNING_PRODUCT = "default";
const MAX_HAP_BYTES = 256 * 1024 * 1024;
const SIGNING_TEMPLATE_FILES = [
  "build-profile.json5",
  "oh-package.json5",
  "hvigorfile.ts",
  "hvigor/hvigor-config.json5",
  "AppScope/app.json5",
  "entry/build-profile.json5",
  "entry/oh-package.json5",
  "entry/hvigorfile.ts",
  "entry/src/main/module.json5",
] as const;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...keys].sort());

interface SigningMaterial {
  certpath: string;
  keyAlias: string;
  keyPassword: string;
  profile: string;
  signAlg: string;
  storeFile: string;
  storePassword: string;
}

interface LocalSigningOptions {
  sourceHapPath: string;
  hdcPath: string;
  deviceUdid: string;
  cacheDirectory: string;
  descriptorPath?: string;
  environment?: NodeJS.ProcessEnv;
  execute?: CommandExecutor;
  signal?: AbortSignal;
  signHap?: typeof signHapWithJava;
  devecoCliPath?: string;
  signingTemplatePath?: string;
  runtimeExecutablePath?: string;
}

interface LoadedSigningMaterial {
  material: SigningMaterial;
  configRoot: string;
  verifiedMarker?: string;
}

interface SigningTemplateSnapshot {
  digest: string;
  files: Map<(typeof SIGNING_TEMPLATE_FILES)[number], Buffer>;
}

declare global {
  var __pioraHarmonyMirrorSigning: Map<string, Promise<string>> | undefined;
}

function signingJobs(): Map<string, Promise<string>> {
  return globalThis.__pioraHarmonyMirrorSigning ??= new Map();
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function regularFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    throw new Error("invalid regular file");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error("file changed while being read");
  }
  return bytes;
}

async function jsonFile(path: string, maximum = 1024 * 1024): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maximum)));
}

async function json5File(path: string, maximum = 1024 * 1024): Promise<unknown> {
  return JSON5.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maximum)));
}

function isMissing(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function requirePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("private signing directory is invalid");
  await chmod(path, 0o700).catch(() => undefined);
  return await realpath(path);
}

async function firstRegularFile(candidates: Array<string | undefined>, maximum: number): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await regularFile(candidate, maximum);
      return resolve(candidate);
    } catch { /* try the next reviewed location */ }
  }
  throw new Error("required DevEco tool is unavailable");
}

function candidateSdkRoots(hdcPath: string, environment: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const add = (value: string | undefined) => {
    if (!value?.trim() || !isAbsolute(value.trim())) return;
    const absolute = resolve(value.trim());
    const name = basename(absolute).toLocaleLowerCase();
    if (name === "toolchains") {
      const component = dirname(absolute);
      roots.push(basename(component).toLocaleLowerCase() === "openharmony" ? dirname(component) : component);
      return;
    }
    if (name === "openharmony") roots.push(dirname(absolute));
    else roots.push(absolute, join(absolute, "default"));
  };
  const hdcDirectory = dirname(hdcPath);
  if (basename(hdcDirectory).toLocaleLowerCase() === "toolchains") add(hdcDirectory);
  add(environment.DEVECO_SDK_HOME);
  add(environment.HARMONY_SDK_HOME);
  if (environment.DEVECO_STUDIO_HOME?.trim()) add(join(environment.DEVECO_STUDIO_HOME.trim(), "sdk"));
  return [...new Set(roots)];
}

export async function resolveSigningTools(hdcPath: string, environment: NodeJS.ProcessEnv) {
  let sdkDefault: string | undefined;
  let toolchains: string | undefined;
  for (const candidate of candidateSdkRoots(hdcPath, environment)) {
    try {
      const metadata = await jsonFile(join(candidate, "sdk-pkg.json"), 1024 * 1024);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
        || (metadata as { data?: { apiVersion?: unknown } }).data?.apiVersion !== "26"
        || (metadata as { data?: { platformVersion?: unknown } }).data?.platformVersion !== "26.0.0") continue;
      const candidateToolchains = await firstRegularFile([
        join(candidate, "openharmony", "toolchains", "lib", "hap-sign-tool.jar"),
        join(candidate, "toolchains", "lib", "hap-sign-tool.jar"),
      ], 64 * 1024 * 1024);
      sdkDefault = candidate;
      toolchains = dirname(dirname(candidateToolchains));
      break;
    } catch { /* try the next reviewed SDK root */ }
  }
  if (!sdkDefault || !toolchains) throw new Error("local HarmonyOS API 26 signing SDK is unavailable");
  const derivedStudioRoot = basename(sdkDefault).toLocaleLowerCase() === "default"
    && basename(dirname(sdkDefault)).toLocaleLowerCase() === "sdk"
    ? dirname(dirname(sdkDefault)) : dirname(sdkDefault);
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const java = await firstRegularFile([
    environment.HARMONY_JAVA_PATH?.trim(),
    environment.JAVA_HOME?.trim() ? join(environment.JAVA_HOME.trim(), "bin", javaName) : undefined,
    environment.DEVECO_STUDIO_HOME?.trim() ? join(environment.DEVECO_STUDIO_HOME.trim(), "jbr", "bin", javaName) : undefined,
    join(derivedStudioRoot, "jbr", "bin", javaName),
  ], 16 * 1024 * 1024);
  const signTool = await firstRegularFile([join(toolchains, "lib", "hap-sign-tool.jar")], 64 * 1024 * 1024);
  const signerSource = await firstRegularFile([
    environment.PIORA_HARMONY_SIGNER_SOURCE_PATH?.trim(),
    environment.PIORA_HARMONY_TOOLS_DIR?.trim()
      ? join(environment.PIORA_HARMONY_TOOLS_DIR.trim(), SIGNER_SOURCE)
      : undefined,
    join(process.cwd(), "lib", "harmony", "runtime", SIGNER_SOURCE),
  ], 64 * 1024);
  return { java, signTool, signerSource };
}

export function validatePublicMirrorReceipt(receipt: unknown, sourceBytes: Buffer): void {
  if (!exactKeys(receipt, ["schemaVersion", "kind", "origin", "artifact", "acceptanceArtifact", "sdk", "signing", "verification", "deviceAcceptance"])
    || receipt.schemaVersion !== 2 || receipt.kind !== "private-device-acceptance-verification") {
    throw new Error("installed Piora mirror resource has no public unsigned receipt");
  }
  const artifact = receipt.artifact;
  const acceptanceArtifact = receipt.acceptanceArtifact;
  const sdk = receipt.sdk;
  const signing = receipt.signing;
  const verification = receipt.verification;
  const deviceAcceptance = receipt.deviceAcceptance;
  const verificationRecord = verification as Record<string, unknown> | undefined;
  const deviceAcceptanceRecord = deviceAcceptance as Record<string, unknown> | undefined;
  if (!exactKeys(artifact, ["filename", "size", "sha256"]) || artifact.filename !== "OHScrcpyServer.hap"
    || artifact.size !== sourceBytes.length || artifact.sha256 !== sha256(sourceBytes)
    || !exactKeys(acceptanceArtifact, ["size", "sha256", "sourceSha256"])
    || typeof acceptanceArtifact.size !== "number" || !Number.isSafeInteger(acceptanceArtifact.size)
    || acceptanceArtifact.size < 1 || acceptanceArtifact.size > MAX_HAP_BYTES
    || !/^[0-9a-f]{64}$/.test(String(acceptanceArtifact.sha256))
    || acceptanceArtifact.sourceSha256 !== artifact.sha256 || acceptanceArtifact.sha256 === artifact.sha256
    || !exactKeys(sdk, ["apiVersion", "platformVersion", "toolVersion", "releaseType", "signToolSha256"])
    || sdk.apiVersion !== "26" || sdk.platformVersion !== "26.0.0"
    || !/^26\.0\.0\.\d+$/.test(String(sdk.toolVersion)) || !/^[0-9a-f]{64}$/.test(String(sdk.signToolSha256))
    || !exactKeys(signing, ["mode", "material", "alias", "profileType", "compatibleVersion", "signCode", "distribution"])
    || signing.mode !== "localSign" || signing.material !== "private DevEco acceptance identity"
    || signing.alias !== "debugKey" || signing.profileType !== "debug" || signing.compatibleVersion !== 26
    || signing.signCode !== true || signing.distribution !== "public artifact remains unsigned"
    || !verificationRecord || typeof verificationRecord !== "object" || Array.isArray(verificationRecord)
    || verificationRecord.verifyApp !== true || verificationRecord.verifyProfile !== true
    || !deviceAcceptanceRecord || typeof deviceAcceptanceRecord !== "object" || Array.isArray(deviceAcceptanceRecord)
    || deviceAcceptanceRecord.passed !== true || deviceAcceptanceRecord.acceptedHapSha256 !== acceptanceArtifact.sha256) {
    throw new Error("installed Piora mirror resource failed its release receipt");
  }
}

export function selectDevEcoSigningMaterial(profile: unknown, productName = SIGNING_PRODUCT): unknown {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("DevEco build profile is invalid");
  }
  const app = (profile as Record<string, unknown>).app;
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new Error("DevEco build profile has no app configuration");
  const products = (app as Record<string, unknown>).products;
  const configurations = (app as Record<string, unknown>).signingConfigs;
  if (!Array.isArray(products) || !Array.isArray(configurations)) {
    throw new Error("DevEco build profile has no generated signing configuration");
  }
  const matchingProducts = products.filter(product => Boolean(product) && typeof product === "object"
    && !Array.isArray(product) && (product as Record<string, unknown>).name === productName);
  if (matchingProducts.length !== 1) throw new Error("DevEco build profile has an ambiguous product");
  const signingConfig = (matchingProducts[0] as Record<string, unknown>).signingConfig;
  if (signingConfig !== productName) throw new Error("DevEco product does not reference its generated signing configuration");
  const matchingConfigurations = configurations.filter(configuration => Boolean(configuration)
    && typeof configuration === "object" && !Array.isArray(configuration)
    && (configuration as Record<string, unknown>).name === signingConfig);
  if (matchingConfigurations.length !== 1) throw new Error("DevEco build profile has an ambiguous signing configuration");
  const selected = matchingConfigurations[0] as Record<string, unknown>;
  if (selected.type !== "HarmonyOS") throw new Error("DevEco signing configuration is not for HarmonyOS");
  return selected.material;
}

async function validateSigningMaterial(raw: unknown, configRoot: string): Promise<SigningMaterial> {
  const materialKeys = ["certpath", "keyAlias", "keyPassword", "profile", "signAlg", "storeFile", "storePassword"];
  if (!exactKeys(raw, materialKeys) || raw.keyAlias !== "debugKey" || raw.signAlg !== "SHA256withECDSA"
    || !isDevEcoProtectedPassword(raw.keyPassword) || !isDevEcoProtectedPassword(raw.storePassword)) {
    throw new Error("unsupported DevEco signing material");
  }
  const material = { ...raw } as unknown as SigningMaterial;
  for (const [field, maximum] of [["certpath", 1024 * 1024], ["profile", 2 * 1024 * 1024], ["storeFile", 2 * 1024 * 1024]] as const) {
    const value = material[field];
    if (!isAbsolute(value)) throw new Error("DevEco signing material path is not absolute");
    const actual = await realpath(value);
    if (!inside(configRoot, actual)) throw new Error("DevEco signing material leaves the config directory");
    await regularFile(actual, maximum);
    material[field] = actual;
  }
  return material;
}

async function readSigningDescriptor(requested: string, configRoot: string): Promise<LoadedSigningMaterial> {
  const actualDescriptor = await realpath(requested);
  if (!inside(configRoot, actualDescriptor)) throw new Error("signing descriptor leaves the DevEco config directory");
  const descriptor = await jsonFile(actualDescriptor, 64 * 1024);
  if (!exactKeys(descriptor, ["schemaVersion", "name", "type", "material"])
    || descriptor.schemaVersion !== 1 || descriptor.name !== "pioraHarmonyDevice" || descriptor.type !== "HarmonyOS") {
    throw new Error("unsupported signing descriptor");
  }
  return { material: await validateSigningMaterial(descriptor.material, configRoot), configRoot };
}

async function signingTemplateRoot(sourceHapPath: string, environment: NodeJS.ProcessEnv, explicit?: string): Promise<string> {
  const configured = explicit?.trim() || environment.PIORA_HARMONY_SIGNING_TEMPLATE_PATH?.trim();
  const candidates = configured ? [configured] : [
    join(dirname(sourceHapPath), "signing-project"),
    join(process.cwd(), "third_party", "harmony-mirror"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const status = await lstat(candidate);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("invalid signing template directory");
      return await realpath(candidate);
    } catch (error) {
      if (configured || !isMissing(error)) throw error;
    }
  }
  throw new Error("the Piora DevEco signing project template is unavailable");
}

async function validateSigningProject(projectRoot: string): Promise<void> {
  const [profile, appScope, moduleProfile] = await Promise.all([
    json5File(join(projectRoot, "build-profile.json5"), 256 * 1024),
    json5File(join(projectRoot, "AppScope", "app.json5"), 64 * 1024),
    json5File(join(projectRoot, "entry", "src", "main", "module.json5"), 128 * 1024),
  ]);
  const profileRecord = profile as Record<string, unknown> | undefined;
  const app = profileRecord?.app as Record<string, unknown> | undefined;
  const products = app?.products;
  const modules = profileRecord?.modules;
  const matchingProducts = Array.isArray(products) ? products.filter(product => Boolean(product)
    && typeof product === "object" && !Array.isArray(product)
    && (product as Record<string, unknown>).name === SIGNING_PRODUCT) : [];
  const matchingModules = Array.isArray(modules) ? modules.filter(module => Boolean(module)
    && typeof module === "object" && !Array.isArray(module)
    && (module as Record<string, unknown>).name === "entry"
    && (module as Record<string, unknown>).srcPath === "./entry") : [];
  const application = (appScope as Record<string, unknown> | undefined)?.app as Record<string, unknown> | undefined;
  const moduleConfig = (moduleProfile as Record<string, unknown> | undefined)?.module as Record<string, unknown> | undefined;
  if (matchingProducts.length !== 1 || matchingModules.length !== 1
    || application?.bundleName !== MIRROR_BUNDLE || moduleConfig?.name !== "entry" || moduleConfig?.type !== "entry") {
    throw new Error("the Piora DevEco signing project has an unexpected application identity");
  }
}

async function readSigningTemplate(templateRoot: string): Promise<SigningTemplateSnapshot> {
  const files = new Map<(typeof SIGNING_TEMPLATE_FILES)[number], Buffer>();
  const hash = createHash("sha256");
  for (const relativePath of SIGNING_TEMPLATE_FILES) {
    const source = resolve(templateRoot, relativePath);
    if (!inside(templateRoot, source)) throw new Error("signing template path escaped its root");
    const bytes = await regularFile(source, 256 * 1024);
    files.set(relativePath, bytes);
    hash.update(relativePath).update("\0").update(bytes).update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

async function writeSigningProjectFile(projectRoot: string, relativePath: string, bytes: Buffer): Promise<void> {
  const destination = join(projectRoot, relativePath);
  const actualDirectory = await requirePrivateDirectory(dirname(destination));
  if (!inside(projectRoot, actualDirectory)) throw new Error("private signing project path escaped its root");
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("private signing project file is invalid");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await writeFile(destination, bytes, { mode: 0o600 });
  await chmod(destination, 0o600).catch(() => undefined);
}

async function refreshSigningProject(projectRoot: string, snapshot: SigningTemplateSnapshot,
  preservedMaterial?: SigningMaterial): Promise<void> {
  for (const relativePath of SIGNING_TEMPLATE_FILES) {
    let bytes = snapshot.files.get(relativePath);
    if (!bytes) throw new Error("signing template snapshot is incomplete");
    if (relativePath === "build-profile.json5" && preservedMaterial) {
      const profile = JSON5.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      const app = profile.app as Record<string, unknown>;
      const products = app.products as Array<Record<string, unknown>>;
      const product = products.find(candidate => candidate.name === SIGNING_PRODUCT);
      if (!product) throw new Error("signing template has no default product");
      product.signingConfig = SIGNING_PRODUCT;
      app.signingConfigs = [{ name: SIGNING_PRODUCT, type: "HarmonyOS", material: preservedMaterial }];
      bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
    }
    await writeSigningProjectFile(projectRoot, relativePath, bytes);
  }
  await rm(join(projectRoot, ".piora-device-profiles"), { recursive: true, force: true });
  await writeSigningProjectFile(projectRoot, SIGNING_TEMPLATE_FINGERPRINT, Buffer.from(`${snapshot.digest}\n`, "utf8"));
}

async function currentTemplateFingerprint(projectRoot: string): Promise<string | undefined> {
  try {
    const value = (await regularFile(join(projectRoot, SIGNING_TEMPLATE_FINGERPRINT), 128)).toString("utf8").trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

async function createSigningProject(templateRoot: string, cacheDirectory: string, configRoot: string): Promise<string> {
  const snapshot = await readSigningTemplate(templateRoot);
  const projectRoot = join(cacheDirectory, SIGNING_PROJECT);
  try {
    const existing = await lstat(projectRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("private DevEco signing project is invalid");
    const actualProjectRoot = await realpath(projectRoot);
    if (await currentTemplateFingerprint(actualProjectRoot) !== snapshot.digest) {
      let preservedMaterial: SigningMaterial | undefined;
      try {
        preservedMaterial = await validateSigningMaterial(selectDevEcoSigningMaterial(
          await json5File(join(actualProjectRoot, "build-profile.json5"), 256 * 1024),
        ), configRoot);
      } catch { /* a stale or invalid generated config is replaced by DevEco CLI */ }
      await refreshSigningProject(actualProjectRoot, snapshot, preservedMaterial);
    }
    await validateSigningProject(actualProjectRoot);
    return actualProjectRoot;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporary = await mkdtemp(join(cacheDirectory, ".deveco-signing-project-"));
  try {
    await refreshSigningProject(temporary, snapshot);
    await validateSigningProject(temporary);
    try {
      await rename(temporary, projectRoot);
    } catch (error) {
      if (!await lstat(projectRoot).then(status => status.isDirectory() && !status.isSymbolicLink()).catch(() => false)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await validateSigningProject(projectRoot);
  return await realpath(projectRoot);
}

async function resolveDevEcoCli(environment: NodeJS.ProcessEnv, explicit?: string): Promise<string> {
  const configured = explicit?.trim() || environment.PIORA_DEVECO_CLI_PATH?.trim();
  if (configured) return await firstRegularFile([configured], 64 * 1024 * 1024);
  const runtimeRoot = environment.PIORA_WEB_RUNTIME_ROOT?.trim();
  return await firstRegularFile([
    runtimeRoot && isAbsolute(runtimeRoot)
      ? join(runtimeRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js") : undefined,
    join(process.cwd(), "node_modules", "@deveco", "deveco-cli", "dist", "cli.js"),
  ], 64 * 1024 * 1024);
}

async function markerIsCurrent(path: string): Promise<boolean> {
  try { return (await regularFile(path, 32)).toString("utf8") === "piora-device-profile-v1\n"; }
  catch { return false; }
}

export async function resolveLocalSigningMaterial(options: Pick<LocalSigningOptions,
  "cacheDirectory" | "descriptorPath" | "devecoCliPath" | "deviceUdid" | "environment" | "execute"
  | "runtimeExecutablePath" | "signingTemplatePath" | "signal" | "sourceHapPath">): Promise<LoadedSigningMaterial> {
  const environment = options.environment ?? process.env;
  const userHome = environment.USERPROFILE?.trim() || homedir();
  const configRoot = await requirePrivateDirectory(join(userHome, ".ohos", "config"));
  const configuredDescriptor = options.descriptorPath?.trim() || environment.PIORA_HARMONY_SIGNING_CONFIG_PATH?.trim();
  if (configuredDescriptor) {
    if (!isAbsolute(configuredDescriptor)) throw new Error("signing descriptor path is not absolute");
    return await readSigningDescriptor(resolve(configuredDescriptor), configRoot);
  }
  const defaultDescriptor = join(configRoot, SIGNING_DESCRIPTOR);
  try {
    return await readSigningDescriptor(defaultDescriptor, configRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const cacheDirectory = await requirePrivateDirectory(resolve(options.cacheDirectory));
  const templateRoot = await signingTemplateRoot(resolve(options.sourceHapPath), environment, options.signingTemplatePath);
  const projectRoot = await createSigningProject(templateRoot, cacheDirectory, configRoot);
  const markerDirectory = join(projectRoot, ".piora-device-profiles");
  const marker = join(markerDirectory, `${sha256(options.deviceUdid.toLocaleLowerCase())}.verified`);
  if (!await markerIsCurrent(marker)) {
    const cliPath = await resolveDevEcoCli(environment, options.devecoCliPath);
    const executable = resolve(options.runtimeExecutablePath ?? process.execPath);
    await (options.execute ?? runCommand)({
      executable,
      args: [cliPath, "signature", "generate", "--product", SIGNING_PRODUCT],
      cwd: projectRoot,
      env: {
        ...environment,
        DEVECO_CLI_DISABLE_TELEMETRY: "1",
        DEVECO_CLI_DISABLE_UPDATE: "1",
      },
      signal: options.signal,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
      operation: "generate_local_mirror_signing_profile",
    });
  }
  await validateSigningProject(projectRoot);
  let material: SigningMaterial;
  try {
    material = await validateSigningMaterial(
      selectDevEcoSigningMaterial(await json5File(join(projectRoot, "build-profile.json5"), 256 * 1024)),
      configRoot,
    );
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
  return { material, configRoot, verifiedMarker: marker };
}

function validateGeneratedMarkerPath(path: string): string {
  const absolute = resolve(path);
  if (!isAbsolute(path) || basename(dirname(absolute)) !== ".piora-device-profiles"
    || !/^[0-9a-f]{64}\.verified$/.test(basename(absolute))) {
    throw new Error("generated signing profile marker path is invalid");
  }
  return absolute;
}

async function markSigningMaterialVerified(path: string | undefined): Promise<void> {
  if (!path) return;
  if (await markerIsCurrent(path)) return;
  const actualPath = validateGeneratedMarkerPath(path);
  const directory = await requirePrivateDirectory(dirname(actualPath));
  if (!inside(directory, actualPath)) throw new Error("signing profile marker leaves its private directory");
  const temporary = join(directory, `.verified-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, "piora-device-profile-v1\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rm(actualPath, { force: true });
    await rename(temporary, actualPath);
  }
  finally { await rm(temporary, { force: true }); }
}

async function invalidateSigningMaterialMarker(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(validateGeneratedMarkerPath(path), { force: true });
}

export async function runWithSigningMaterialRecovery<T>(verifiedMarker: string | undefined,
  operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const cancelled = isHarmonyError(error) && error.code === "COMMAND_ABORTED"
      || error instanceof DOMException && error.name === "AbortError";
    if (!cancelled) await invalidateSigningMaterialMarker(verifiedMarker);
    throw error;
  }
}

function certificateBlocks(bytes: Buffer): X509Certificate[] {
  return (bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [])
    .map(value => new X509Certificate(value));
}

function validateProfile(result: unknown, deviceUdid: string, expectedCertificate: X509Certificate, now = Date.now()) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("profile verification result is invalid");
  const verified = result as Record<string, unknown>;
  const profile = verified.content as Record<string, unknown> | undefined;
  const info = profile?.["bundle-info"] as Record<string, unknown> | undefined;
  const debug = profile?.["debug-info"] as Record<string, unknown> | undefined;
  const validity = profile?.validity as Record<string, unknown> | undefined;
  const acls = (profile?.acls as Record<string, unknown> | undefined)?.["allowed-acls"];
  const restricted = (profile?.permissions as Record<string, unknown> | undefined)?.["restricted-permissions"];
  const ids = debug?.["device-ids"];
  if (verified.verifiedPassed !== true || verified.message !== "OK" || profile?.type !== "debug" || profile.issuer !== "app_gallery"
    || info?.["bundle-name"] !== MIRROR_BUNDLE || info.apl !== "normal" || info["app-feature"] !== "hos_normal_app"
    || (acls !== undefined && (!Array.isArray(acls) || acls.length !== 0))
    || (restricted !== undefined && (!Array.isArray(restricted) || restricted.length !== 0))
    || profile["app-privilege-capabilities"] !== undefined
    || debug?.["device-id-type"] !== "udid" || !Array.isArray(ids)
    || !ids.some(value => typeof value === "string" && value.toLocaleLowerCase() === deviceUdid.toLocaleLowerCase())) {
    throw new Error("DevEco profile is not valid for this ordinary app and connected phone");
  }
  const notBefore = validity?.["not-before"];
  const notAfter = validity?.["not-after"];
  const certificateFrom = new Date(expectedCertificate.validFrom).getTime();
  const certificateTo = new Date(expectedCertificate.validTo).getTime();
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter)
    || Number(notBefore) * 1000 > now || Number(notAfter) * 1000 <= now
    || Number(notBefore) * 1000 < certificateFrom || Number(notAfter) * 1000 > certificateTo) {
    throw new Error("DevEco profile or certificate is not currently valid");
  }
  let embedded: X509Certificate;
  try { embedded = new X509Certificate(String(info["development-certificate"])); }
  catch { throw new Error("DevEco profile has no valid development certificate"); }
  if (!embedded.raw.equals(expectedCertificate.raw)) throw new Error("DevEco profile and application certificate differ");
}

async function runVerification(execute: CommandExecutor, tools: Awaited<ReturnType<typeof resolveSigningTools>>,
  signedHap: string, profilePath: string, certificatePath: string, deviceUdid: string, temporary: string, signal?: AbortSignal) {
  const extractedCertificate = join(temporary, "certificate.cer");
  const extractedProfile = join(temporary, "profile.p7b");
  const profileJson = join(temporary, "profile.json");
  const base = { executable: tools.java, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024, signal, cwd: temporary };
  await execute({ ...base, args: ["-jar", tools.signTool, "verify-app", "-inFile", signedHap,
    "-outCertChain", extractedCertificate, "-outProfile", extractedProfile], operation: "verify_local_mirror_signature" });
  await execute({ ...base, args: ["-jar", tools.signTool, "verify-profile", "-inFile", extractedProfile,
    "-outFile", profileJson], operation: "verify_local_mirror_profile" });
  const [expectedCertificates, actualCertificates, configuredProfile, extractedProfileBytes] = await Promise.all([
    regularFile(certificatePath, 1024 * 1024).then(certificateBlocks),
    regularFile(extractedCertificate, 1024 * 1024).then(certificateBlocks),
    regularFile(profilePath, 2 * 1024 * 1024),
    regularFile(extractedProfile, 2 * 1024 * 1024),
  ]);
  const expectedLeaf = expectedCertificates.find(certificate => !certificate.ca);
  const actualLeaf = actualCertificates.find(certificate => !certificate.ca);
  if (!expectedLeaf || !actualLeaf || !expectedLeaf.raw.equals(actualLeaf.raw)
    || sha256(configuredProfile) !== sha256(extractedProfileBytes)) {
    throw new Error("local signed HAP does not contain the selected DevEco identity");
  }
  validateProfile(await jsonFile(profileJson, 2 * 1024 * 1024), deviceUdid, expectedLeaf);
}

export async function readVerifiedCachedMirrorHap(
  cacheHap: string,
  cacheReceipt: string,
  expected: Record<"publicSha256" | "materialSha256" | "deviceSha256", string>,
  verify: (path: string) => Promise<void>,
): Promise<string | undefined> {
  try {
    const receipt = await jsonFile(cacheReceipt, 64 * 1024);
    if (!exactKeys(receipt, ["schemaVersion", "publicSha256", "materialSha256", "deviceSha256", "signedSha256"])
      || receipt.schemaVersion !== 1 || receipt.publicSha256 !== expected.publicSha256
      || receipt.materialSha256 !== expected.materialSha256 || receipt.deviceSha256 !== expected.deviceSha256
      || !/^[0-9a-f]{64}$/.test(String(receipt.signedSha256))) return;
    const signedBytes = await regularFile(cacheHap, MAX_HAP_BYTES);
    if (sha256(signedBytes) !== receipt.signedSha256) return;
    await verify(cacheHap);
    return cacheHap;
  } catch (error) {
    if (isHarmonyError(error) && error.code === "COMMAND_ABORTED" || error instanceof DOMException && error.name === "AbortError") throw error;
    return undefined;
  }
}

async function prepare(options: LocalSigningOptions): Promise<string> {
  const environment = options.environment ?? process.env;
  if (!/^[0-9a-f]{64}$/i.test(options.deviceUdid)) throw new Error("connected phone returned an invalid UDID");
  const sourceHap = resolve(options.sourceHapPath);
  const sourceBytes = await regularFile(sourceHap, MAX_HAP_BYTES);
  const publicReceipt = await jsonFile(join(dirname(sourceHap), "harmony-mirror-signature-verification.json"), 1024 * 1024);
  validatePublicMirrorReceipt(publicReceipt, sourceBytes);
  const preview = await previewHapArtifact(sourceHap, options.signal);
  if (preview.bundleName !== MIRROR_BUNDLE || preview.versionCode === undefined || preview.versionName === undefined
    || !preview.abilities.includes("EntryAbility")) throw new Error("installed Piora mirror resource is invalid");

  const [signing, tools] = await Promise.all([
    resolveLocalSigningMaterial({
      cacheDirectory: options.cacheDirectory,
      descriptorPath: options.descriptorPath,
      devecoCliPath: options.devecoCliPath,
      deviceUdid: options.deviceUdid,
      environment,
      execute: options.execute,
      runtimeExecutablePath: options.runtimeExecutablePath,
      signingTemplatePath: options.signingTemplatePath,
      signal: options.signal,
      sourceHapPath: sourceHap,
    }),
    resolveSigningTools(options.hdcPath, environment),
  ]);
  const { material, verifiedMarker } = signing;
  return await runWithSigningMaterialRecovery(verifiedMarker, async () => {
  const [profileBytes, certificateBytes, storeBytes, signToolBytes, signerBytes] = await Promise.all([
    regularFile(material.profile, 2 * 1024 * 1024),
    regularFile(material.certpath, 1024 * 1024),
    regularFile(material.storeFile, 2 * 1024 * 1024),
    regularFile(tools.signTool, 64 * 1024 * 1024),
    regularFile(tools.signerSource, 64 * 1024),
  ]);
  const publicSha256 = sha256(sourceBytes);
  const deviceSha256 = sha256(options.deviceUdid.toLocaleLowerCase());
  const materialSha256 = createHash("sha256").update(profileBytes).update(certificateBytes).update(storeBytes)
    .update(signToolBytes).update(signerBytes).update(material.keyAlias + "\0" + material.signAlg).digest("hex");
  profileBytes.fill(0);
  certificateBytes.fill(0);
  storeBytes.fill(0);
  await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
  const cacheStatus = await lstat(options.cacheDirectory);
  if (!cacheStatus.isDirectory() || cacheStatus.isSymbolicLink()) throw new Error("private mirror cache is invalid");
  await chmod(options.cacheDirectory, 0o700).catch(() => undefined);
  const cacheKey = sha256(`${publicSha256}\0${materialSha256}\0${deviceSha256}`);
  const cacheHap = join(options.cacheDirectory, `mirror-${cacheKey}.hap`);
  const cacheReceipt = `${cacheHap}.json`;
  const expected = { publicSha256, materialSha256, deviceSha256 };
  const cachedVerification = await mkdtemp(join(options.cacheDirectory, `.checking-${cacheKey.slice(0, 12)}-`));
  let cached: string | undefined;
  try {
    cached = await readVerifiedCachedMirrorHap(cacheHap, cacheReceipt, expected,
      async path => await runWithSigningMaterialRecovery(verifiedMarker,
        async () => await runVerification(options.execute ?? runCommand, tools, path, material.profile,
          material.certpath, options.deviceUdid, cachedVerification, options.signal)));
  } finally {
    await rm(cachedVerification, { recursive: true, force: true });
  }
  if (cached) {
    await markSigningMaterialVerified(verifiedMarker);
    return cached;
  }
  await rm(cacheHap, { force: true });
  await rm(cacheReceipt, { force: true });

  const temporary = await mkdtemp(join(options.cacheDirectory, `.signing-${cacheKey.slice(0, 12)}-`));
  const unsignedTemporary = join(temporary, "unsigned.hap");
  const signedTemporary = join(temporary, "signed.hap");
  let keyPassword: string | undefined;
  let storePassword: string | undefined;
  try {
    await writeFile(unsignedTemporary, sourceBytes, { flag: "wx", mode: 0o600 });
    const copiedPreview = await previewHapArtifact(unsignedTemporary, options.signal);
    if (copiedPreview.bundleName !== preview.bundleName || copiedPreview.versionCode !== preview.versionCode
      || copiedPreview.versionName !== preview.versionName || copiedPreview.moduleName !== preview.moduleName) {
      throw new Error("public mirror resource changed while preparing its private signature");
    }
    [keyPassword, storePassword] = await Promise.all([
      decryptDevEcoProtectedPassword(dirname(material.storeFile), material.keyPassword),
      decryptDevEcoProtectedPassword(dirname(material.storeFile), material.storePassword),
    ]);
    await (options.signHap ?? signHapWithJava)({
      javaPath: tools.java,
      signToolPath: tools.signTool,
      signerSourcePath: tools.signerSource,
      keyAlias: material.keyAlias,
      keyPassword,
      certificatePath: material.certpath,
      profilePath: material.profile,
      inputPath: unsignedTemporary,
      signAlgorithm: material.signAlg,
      storePath: material.storeFile,
      storePassword,
      outputPath: signedTemporary,
      compatibleVersion: 26,
      cwd: temporary,
      env: environment,
      signal: options.signal,
      timeoutMs: 120_000,
    });
    keyPassword = undefined;
    storePassword = undefined;
    const signedBytes = await regularFile(signedTemporary, MAX_HAP_BYTES);
    const signedPreview = await previewHapArtifact(signedTemporary, options.signal);
    if (signedPreview.bundleName !== preview.bundleName || signedPreview.versionCode !== preview.versionCode
      || signedPreview.versionName !== preview.versionName || signedPreview.moduleName !== preview.moduleName) {
      throw new Error("local signing changed the mirror application identity");
    }
    await runVerification(options.execute ?? runCommand, tools, signedTemporary, material.profile,
      material.certpath, options.deviceUdid, temporary, options.signal);
    const signedSha256 = sha256(signedBytes);
    await chmod(signedTemporary, 0o600).catch(() => undefined);
    await rename(signedTemporary, cacheHap);
    await writeFile(cacheReceipt, `${JSON.stringify({ schemaVersion: 1, ...expected, signedSha256 }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    await markSigningMaterialVerified(verifiedMarker);
    return cacheHap;
  } finally {
    keyPassword = undefined;
    storePassword = undefined;
    await rm(temporary, { recursive: true, force: true });
  }
  });
}

export async function prepareLocalMirrorHap(options: LocalSigningOptions): Promise<string> {
  if (options.signal?.aborted) {
    throw new HarmonyError("COMMAND_ABORTED", "Harmony HAP signing was cancelled", {
      retryable: true,
      details: { reason: "mirror-local-signing-cancelled", dispatchState: "not-sent" },
    });
  }
  const key = `${resolve(options.sourceHapPath)}\0${sha256(options.deviceUdid.toLocaleLowerCase())}\0${resolve(options.cacheDirectory)}`;
  const existing = signingJobs().get(key);
  if (existing) return await existing;
  const task = prepare(options).catch(cause => {
    if (isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
    if (options.signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") {
      throw new HarmonyError("COMMAND_ABORTED", "Harmony HAP signing was cancelled", {
        cause,
        retryable: true,
        details: { reason: "mirror-local-signing-cancelled", dispatchState: "not-sent" },
      });
    }
    throw new HarmonyError("CAPABILITY_UNAVAILABLE",
      "Piora could not create the private Harmony video component. Run `devecocli auth login`, keep this phone connected and unlocked, then initialize again.",
      { cause, details: { reason: "mirror-local-signing-unavailable", dispatchState: "not-sent" } });
  }).finally(() => signingJobs().delete(key));
  signingJobs().set(key, task);
  return await task;
}
