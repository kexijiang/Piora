import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";

export const RELEASE_REPOSITORY = Object.freeze({ owner: "kexijiang", repo: "Piora" });
const profiles = {
  piora: { artifactPrefix: "Piora", stable: "latest", preview: "beta" },
};
const assetTypes = {
  icon: [".svg", 1024 * 1024],
  trayIcon: [".png", 1024 * 1024],
  startupVideo: [".mp4", 12_000_000],
  startupPoster: [".jpg", 1_000_000],
  portableSplash: [".bmp", 4_000_000],
};

export async function resolveBrandAsset(directory, name, kind) {
  if (typeof name !== "string" || !name || isAbsolute(name)) throw new Error(`Invalid ${kind} path`);
  const root = await realpath(directory);
  const file = await realpath(resolve(root, name));
  const within = relative(root, file);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error(`${kind} escapes the brand directory`);
  const [extension, limit] = assetTypes[kind];
  const info = await stat(file);
  if (extname(file).toLowerCase() !== extension || !info.isFile() || info.size === 0 || info.size > limit) {
    throw new Error(`Invalid ${kind} resource: ${name}`);
  }
  const bytes = await readFile(file);
  if (kind === "icon") {
    const svg = bytes.toString("utf8");
    if (!/<svg[\s>]/i.test(svg) || /<!DOCTYPE|<!ENTITY|<script|<foreignObject|\bon\w+\s*=|(?:href|url)\s*[=(]/i.test(svg)) {
      throw new Error("Brand SVG must be self-contained and contain no scripts or external references");
    }
  }
  if (kind === "startupVideo" && bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("Invalid MP4 header");
  if (kind === "startupPoster" && (bytes[0] !== 0xff || bytes[1] !== 0xd8)) throw new Error("Invalid JPEG header");
  if (kind === "portableSplash" && bytes.toString("ascii", 0, 2) !== "BM") throw new Error("Invalid BMP header");
  return file;
}

export async function loadBranding(projectRoot, requestedBrand = process.env.PIORA_BRAND ?? "piora") {
  if (!Object.hasOwn(profiles, requestedBrand)) throw new Error(`Unknown PIORA_BRAND: ${requestedBrand}`);
  const directory = resolve(projectRoot, "branding", requestedBrand);
  const input = JSON.parse(await readFile(resolve(directory, "branding.json"), "utf8"));
  const allowed = new Set(["id", "displayName", "artifactPrefix", "updateChannels", ...Object.keys(assetTypes)]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    throw new Error("Brand configuration contains unsupported fields");
  }
  const expected = profiles[requestedBrand];
  if (input.id !== requestedBrand || input.artifactPrefix !== expected.artifactPrefix
    || input.updateChannels?.stable !== expected.stable || input.updateChannels?.preview !== expected.preview
    || Object.keys(input.updateChannels).length !== 2) throw new Error("Brand identity, artifact prefix and update channels must agree");
  if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 64
    || /[\x00-\x1f<>:"/\\|?*]/.test(input.displayName) || input.displayName !== input.displayName.trim()) {
    throw new Error("Invalid brand displayName");
  }
  const assets = {};
  for (const kind of Object.keys(assetTypes)) {
    if (input[kind] !== undefined) assets[kind] = await resolveBrandAsset(directory, input[kind], kind);
  }
  if (requestedBrand === "piora") {
    assets.icon ??= resolve(projectRoot, "desktop/build/piora-icon.svg");
    assets.startupVideo ??= resolve(projectRoot, "desktop/build/startup/polaris-rover.mp4");
    assets.startupPoster ??= resolve(projectRoot, "desktop/build/startup/polaris-rover.jpg");
    assets.portableSplash ??= resolve(projectRoot, "desktop/build/portable-splash.bmp");
  }
  return {
    id: input.id, displayName: input.displayName, artifactPrefix: input.artifactPrefix,
    updateChannels: input.updateChannels, repository: RELEASE_REPOSITORY,
    audienceFile: "release-audience.json",
    updaterCacheDirName: "@pioradesktop-updater",
    assets,
  };
}

export function runtimeBranding(brand) {
  const { assets, ...runtime } = brand;
  return {
    ...runtime,
    startup: {
      video: assets.startupVideo ? "polaris-rover.mp4" : null,
      poster: assets.startupPoster ? "polaris-rover.jpg" : null,
    },
  };
}
