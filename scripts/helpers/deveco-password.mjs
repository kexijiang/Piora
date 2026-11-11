import { spawn } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const COMPONENT = Buffer.from([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119]);
const MATERIAL_DIRECTORIES = ["fd", "ac", "ce"];

export function isDevEcoProtectedPassword(value) {
  if (typeof value !== "string" || value.length < 66 || value.length > 544
    || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return false;
  const bytes = Buffer.from(value, "hex");
  if (bytes.length < 33) return false;
  const encryptedLength = bytes.readUInt32BE(0);
  return encryptedLength >= 17 && encryptedLength <= 272 && bytes.length - 4 - encryptedLength === 12;
}

async function boundedRegularFile(path, maximum) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > maximum) {
    throw new Error("DevEco protected-password material is invalid");
  }
  const bytes = await readFile(path);
  if (bytes.length !== status.size) throw new Error("DevEco protected-password material changed while being read");
  return bytes;
}

async function onlyMaterialFile(directory, maximum) {
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password material directory is invalid");
  }
  const entries = (await readdir(directory)).filter(name => name !== ".DS_Store");
  if (entries.length !== 1) throw new Error("DevEco protected-password material directory is ambiguous");
  return await boundedRegularFile(join(directory, entries[0]), maximum);
}

function decryptContainer(key, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) throw new Error("DevEco encrypted material is truncated");
  const encryptedLength = bytes.readUInt32BE(0);
  const ivLength = bytes.length - 4 - encryptedLength;
  const encryptedBodyLength = encryptedLength - 16;
  if (ivLength !== 12 || encryptedBodyLength < 1 || encryptedBodyLength > 256) {
    throw new Error("DevEco encrypted material has an unsupported shape");
  }
  const iv = bytes.subarray(4, 4 + ivLength);
  const encrypted = bytes.subarray(4 + ivLength, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function decryptDevEcoProtectedPassword(materialDirectory, encryptedPassword) {
  if (!isDevEcoProtectedPassword(encryptedPassword)) {
    throw new Error("DevEco protected password has an unsupported shape");
  }
  const materialRoot = join(materialDirectory, "material");
  const rootStatus = await lstat(materialRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password material root is invalid");
  }
  const rootEntries = (await readdir(materialRoot)).filter(name => name !== ".DS_Store");
  if (rootEntries.length !== MATERIAL_DIRECTORIES.length
    || MATERIAL_DIRECTORIES.some(name => !rootEntries.includes(name))) {
    throw new Error("DevEco protected-password material set is incomplete");
  }

  const fdRoot = join(materialRoot, MATERIAL_DIRECTORIES[0]);
  const fdStatus = await lstat(fdRoot);
  if (!fdStatus.isDirectory() || fdStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password key directory is invalid");
  }
  const fdNames = (await readdir(fdRoot)).filter(name => name !== ".DS_Store");
  if (fdNames.length !== 3) throw new Error("DevEco protected-password key material is incomplete");
  const components = await Promise.all(fdNames.map(async name => {
    const bytes = await onlyMaterialFile(join(fdRoot, name), 16);
    if (bytes.length !== 16) throw new Error("DevEco protected-password key material has an invalid size");
    return bytes;
  }));
  components.push(COMPONENT);
  const mixed = Buffer.from(components[0]);
  for (const component of components.slice(1)) {
    for (let index = 0; index < mixed.length; index += 1) mixed[index] ^= component[index];
  }

  const salt = await onlyMaterialFile(join(materialRoot, MATERIAL_DIRECTORIES[1]), 1024);
  const encryptedWorkKey = await onlyMaterialFile(join(materialRoot, MATERIAL_DIRECTORIES[2]), 1024);
  const rootKey = pbkdf2Sync(mixed.toString(), salt, 10_000, 16, "sha256");
  let workKey;
  try {
    workKey = decryptContainer(rootKey, encryptedWorkKey);
    if (workKey.length !== 16) throw new Error("DevEco protected-password work key has an invalid size");
    const plaintext = decryptContainer(workKey, Buffer.from(encryptedPassword, "hex"));
    try {
      const password = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) {
        throw new Error("DevEco protected password decrypted to an invalid value");
      }
      return password;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    mixed.fill(0);
    rootKey.fill(0);
    workKey?.fill(0);
  }
}

export async function signHapWithJava(options) {
  const {
    javaPath, signToolPath, signerSourcePath, keyAlias, keyPassword, certificatePath,
    profilePath, inputPath, signAlgorithm, storePath, storePassword, outputPath,
    compatibleVersion = 26, cwd, env = process.env, signal, timeoutMs = 120_000,
  } = options;
  const args = [
    "-cp", signToolPath, signerSourcePath, keyAlias, certificatePath, profilePath,
    inputPath, signAlgorithm, storePath, outputPath, String(compatibleVersion),
  ];
  const secretInput = Buffer.from(`${keyPassword}\n${storePassword}\n`, "utf8");
  if (signal?.aborted) {
    secretInput.fill(0);
    throw new Error("Harmony HAP signing was cancelled");
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer;
    let child;
    try {
      child = spawn(javaPath, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      secretInput.fill(0);
      reject(new Error("Unable to start the local Harmony HAP signer"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      secretInput.fill(0);
    };
    const sanitized = () => {
      let value = Buffer.concat([...stdout, ...stderr]).toString("utf8").slice(-8_000);
      for (const secret of [keyPassword, storePassword]) {
        if (typeof secret === "string" && secret.length >= 1) value = value.replaceAll(secret, "<redacted>");
      }
      for (const path of [javaPath, signToolPath, signerSourcePath, certificatePath, profilePath, inputPath, storePath, outputPath, cwd]) {
        if (typeof path !== "string" || path.length < 1) continue;
        value = value.replaceAll(path, "<path>").replaceAll(path.replaceAll("\\", "/"), "<path>");
      }
      return value.replace(/[A-Za-z0-9_+/=-]{24,}/g, "<redacted>");
    };
    const wipeOutput = () => {
      for (const bytes of [...stdout, ...stderr]) bytes.fill(0);
      stdout.length = 0;
      stderr.length = 0;
    };
    const finishError = message => {
      if (settled) return;
      settled = true;
      const diagnostics = sanitized();
      cleanup();
      child.kill();
      wipeOutput();
      reject(new Error(`${message}${diagnostics ? `\n${diagnostics}` : ""}`));
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) finishError("Harmony HAP signing exceeded its output limit");
      else target.push(Buffer.from(chunk));
    };
    const abort = () => finishError("Harmony HAP signing was cancelled");
    timer = setTimeout(() => finishError("Harmony HAP signing timed out"), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("error", () => finishError("Unable to start the local Harmony HAP signer"));
    child.on("close", code => {
      if (settled) return;
      settled = true;
      const diagnostics = code === 0 ? "" : sanitized();
      cleanup();
      wipeOutput();
      if (code !== 0) {
        reject(new Error(`Harmony HAP signing failed with exit ${code ?? -1}${diagnostics ? `\n${diagnostics}` : ""}`));
      } else {
        resolve();
      }
    });
    child.stdin.on("error", () => finishError("Unable to provide the local Harmony signing credentials"));
    child.stdin.end(secretInput, () => secretInput.fill(0));
    if (signal?.aborted) abort();
  });
}
