/*
 * MODIFIED APACHE-2.0 ADAPTATION NOTICE
 *
 * This file contains a modified TypeScript adaptation of portions of the
 * OpenAI Codex TUI pet catalog, model, and asset-cache conventions.
 * Copyright 2025 OpenAI. Modified by Piora contributors for local discovery,
 * validation, normalization, and atomic import behavior.
 *
 * See third_party/openai-codex/SOURCE.md, LICENSE, and NOTICE for the pinned
 * upstream revision and Apache-2.0 attribution. The Piora project as a whole
 * remains distributed under its existing MIT license.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import {
  getRuntimeHomeDirectory,
  getRuntimeAgentDataDirectory,
  type RuntimeHomeEnvironment,
} from "./runtime-home";
import { BUNDLED_COMPANION_PETS_PUBLIC_PATH } from "./companion-store";
import { firstPartyRuntimeRoot } from "./first-party-extensions";
import { listCompanionModels, type CompanionModel3D } from "./companion-models";

export const PET_MANIFEST_MAX_BYTES = 64 * 1024;
export const PET_INSTALLED_MANIFEST_MAX_BYTES = 256 * 1024;
export const PET_SPRITESHEET_MAX_BYTES = 16 * 1024 * 1024;
export const PET_IMPORT_REQUEST_MAX_BYTES = 4 * 1024;
export const PET_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
export const PET_ARCHIVE_REQUEST_MAX_BYTES = PET_ARCHIVE_MAX_BYTES + 1024 * 1024;
const PET_ARCHIVE_MAX_ENTRIES = 64;

const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT_V1 = 1872;
const ATLAS_HEIGHT_V2 = 2288;
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const DEFAULT_COLUMNS = 8;
const DEFAULT_ROWS_V1 = 9;
const DEFAULT_ROWS_V2 = 11;
const MAX_PET_FRAMES = 256;
const MAX_ANIMATIONS = 64;
const MAX_ANIMATION_FRAMES = 1024;
const MAX_ANIMATION_FPS = 60;
const MAX_TIMER_DURATION_MS = 2_147_483_647;
const MAX_IMAGE_CONTAINER_CHUNKS = 8_192;
const SAFE_PET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_PET_ID = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const ALLOWED_SPRITESHEETS = new Set(["spritesheet.webp", "spritesheet.png"]);

interface CodexBuiltinPetCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  spritesheetFile: string;
}

/** Current OpenAI Codex TUI v1 catalog; files are discovered locally only. */
const CODEX_BUILTIN_PET_CATALOG: readonly CodexBuiltinPetCatalogEntry[] = [
  { id: "codex", displayName: "Codex", description: "The original Codex companion", spritesheetFile: "codex-spritesheet-v4.webp" },
  { id: "dewey", displayName: "Dewey", description: "A tidy duck for calm workspace days", spritesheetFile: "dewey-spritesheet-v4.webp" },
  { id: "fireball", displayName: "Fireball", description: "Hot path energy for fast iteration", spritesheetFile: "fireball-spritesheet-v4.webp" },
  { id: "rocky", displayName: "Rocky", description: "A steady rock when the diff gets large", spritesheetFile: "rocky-spritesheet-v4.webp" },
  { id: "seedy", displayName: "Seedy", description: "Small green shoots for new ideas", spritesheetFile: "seedy-spritesheet-v4.webp" },
  { id: "stacky", displayName: "Stacky", description: "A balanced stack for deep work", spritesheetFile: "stacky-spritesheet-v4.webp" },
  { id: "bsod", displayName: "BSOD", description: "A tiny blue-screen gremlin", spritesheetFile: "bsod-spritesheet-v4.webp" },
  { id: "null-signal", displayName: "Null Signal", description: "Quiet signal from the void", spritesheetFile: "null-signal-spritesheet-v4.webp" },
];

export interface CompanionPetEnvironment extends RuntimeHomeEnvironment {
  CODEX_HOME?: string;
}

export type CompanionPetSourceKind =
  | "codex-builtin-cache"
  | "codex-custom"
  | "codex-legacy-avatar"
  | "piora-bundled"
  | "piora-installed";

export type CodexPetSourceKind = Exclude<CompanionPetSourceKind, "piora-bundled" | "piora-installed">;

export type PetAnimationStateId =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "look-directions-a"
  | "look-directions-b";

export interface PetAnimationState {
  id: string;
  frameIndices: number[];
  durationsMs: number[];
  loopStart: number | null;
  fallback: string;
  /** Compatibility hints only; frameIndices is the authoritative address. */
  row: number | null;
  frames: number;
  directionsDegrees?: number[];
}

export interface CompanionPetFrame {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface NormalizedPetAnimation {
  frameIndices: number[];
  durationsMs: number[];
  loopStart: number | null;
  fallback: string;
}

export interface CompanionPet {
  model3d?: CompanionModel3D;
  id: string;
  displayName: string;
  description?: string;
  author?: string;
  spriteVersionNumber: 1 | 2;
  spritesheetPath: "spritesheet.webp" | "spritesheet.png";
  atlasUrl: string | null;
  width: number;
  height: number;
  frame: CompanionPetFrame;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  states: PetAnimationState[];
  source: "codex" | "piora";
  sourceKind: CompanionPetSourceKind;
  sourceKey: string;
  origin?: CodexPetSourceKind;
  installed: boolean;
}

export interface CompanionPetDiagnostic {
  scope: "source" | "installed";
  id?: string;
  message: string;
}

export interface CompanionPetsResponse {
  codexSourceAvailable: boolean;
  sources: CompanionPet[];
  installed: CompanionPet[];
  diagnostics: CompanionPetDiagnostic[];
}

export interface NormalizedPetManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  description?: string;
  author?: string;
  spriteVersionNumber: 1 | 2;
  spritesheetPath: "spritesheet.webp" | "spritesheet.png";
  frame: CompanionPetFrame;
  animations: Record<string, NormalizedPetAnimation>;
  origin?: CodexPetSourceKind;
}

export class CompanionPetError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_PET_ID"
      | "INVALID_PET_SOURCE"
      | "PET_NOT_FOUND"
      | "INVALID_PET_PACKAGE"
      | "PET_TOO_LARGE"
      | "PET_ACCESS_DENIED"
      | "PET_IMPORT_FAILED",
    readonly status: number,
  ) {
    super(message);
    this.name = "CompanionPetError";
  }
}

interface SpriteInspection {
  mimeType: "image/png" | "image/webp";
  width: number;
  height: number;
}

interface ValidatedPetPackage {
  manifest: NormalizedPetManifest;
  pet: CompanionPet;
  spritesheetBytes: Buffer;
  mimeType: "image/png" | "image/webp";
  sourceKind: CompanionPetSourceKind;
}

const IDLE_FRAME_INDICES = [0, 1, 2, 3, 4, 5];
const IDLE_DURATIONS_MS = [1680, 660, 660, 840, 840, 1920];

function normalizedAnimation(
  frameIndices: number[],
  durationsMs: number[],
  loopStart: number | null,
  fallback = "idle",
): NormalizedPetAnimation {
  return { frameIndices, durationsMs, loopStart, fallback };
}

function repeatedPrimaryAnimation(
  row: number,
  frameCount: number,
  durationMs: number,
  finalDurationMs: number,
): NormalizedPetAnimation {
  const primary = Array.from(
    { length: frameCount },
    (_, column) => row * DEFAULT_COLUMNS + column,
  );
  const primaryDurations = Array.from(
    { length: frameCount },
    (_, index) => index === frameCount - 1 ? finalDurationMs : durationMs,
  );
  return normalizedAnimation(
    [...primary, ...primary, ...primary, ...IDLE_FRAME_INDICES],
    [...primaryDurations, ...primaryDurations, ...primaryDurations, ...IDLE_DURATIONS_MS],
    primary.length * 3,
  );
}

/** Defaults mirrored from Codex's current pet manifest loader. */
function defaultPetAnimations(spriteVersionNumber: 1 | 2): Record<string, NormalizedPetAnimation> {
  const idle = normalizedAnimation([...IDLE_FRAME_INDICES], [...IDLE_DURATIONS_MS], 0);
  const runningRight = repeatedPrimaryAnimation(1, 8, 120, 220);
  const runningLeft = repeatedPrimaryAnimation(2, 8, 120, 220);
  const waving = repeatedPrimaryAnimation(3, 4, 140, 280);
  const jumping = repeatedPrimaryAnimation(4, 5, 140, 280);
  const failed = repeatedPrimaryAnimation(5, 8, 140, 240);
  const waiting = repeatedPrimaryAnimation(6, 6, 150, 260);
  const running = repeatedPrimaryAnimation(7, 6, 120, 220);
  const review = repeatedPrimaryAnimation(8, 6, 150, 280);
  const animations = Object.assign(Object.create(null) as Record<string, NormalizedPetAnimation>, {
    idle,
    "running-right": runningRight,
    "running-left": runningLeft,
    waving,
    jumping,
    failed,
    waiting,
    running,
    review,
    move_right: runningRight,
    move_left: runningLeft,
    wave: waving,
    bounce: jumping,
    sad: failed,
  });
  if (spriteVersionNumber === 2) {
    animations["look-directions-a"] = normalizedAnimation(
      Array.from({ length: 8 }, (_, index) => 72 + index),
      Array.from({ length: 8 }, () => 150),
      0,
    );
    animations["look-directions-b"] = normalizedAnimation(
      Array.from({ length: 8 }, (_, index) => 80 + index),
      Array.from({ length: 8 }, () => 150),
      0,
    );
  }
  return animations;
}

function contiguousRow(frameIndices: readonly number[], columns: number): number | null {
  if (frameIndices.length === 0) return null;
  const first = frameIndices[0];
  const row = Math.floor(first / columns);
  return frameIndices.every(
    (frameIndex, index) => frameIndex === first + index && Math.floor(frameIndex / columns) === row,
  ) ? row : null;
}

function petAnimationStates(
  animations: Readonly<Record<string, NormalizedPetAnimation>>,
  columns: number,
): PetAnimationState[] {
  return Object.entries(animations).map(([id, animation]) => ({
    id,
    frameIndices: [...animation.frameIndices],
    durationsMs: [...animation.durationsMs],
    loopStart: animation.loopStart,
    fallback: animation.fallback,
    row: contiguousRow(animation.frameIndices, columns),
    frames: animation.frameIndices.length,
    ...(id === "look-directions-a" && animation.frameIndices.length === 8
      ? { directionsDegrees: [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5] }
      : id === "look-directions-b" && animation.frameIndices.length === 8
        ? { directionsDegrees: [180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5] }
        : {}),
  }));
}

export function getCodexPetAnimationStates(spriteVersionNumber: 1 | 2): PetAnimationState[] {
  return petAnimationStates(defaultPetAnimations(spriteVersionNumber), DEFAULT_COLUMNS);
}

export function isValidPetId(value: unknown): value is string {
  return typeof value === "string"
    && SAFE_PET_ID.test(value)
    && value !== "."
    && value !== ".."
    && !value.endsWith(".")
    && !WINDOWS_DEVICE_PET_ID.test(value);
}

function requireValidPetId(value: string): string {
  if (!isValidPetId(value)) {
    throw new CompanionPetError(
      "Pet id must be 1-64 ASCII letters, numbers, dots, underscores, or hyphens",
      "INVALID_PET_ID",
      400,
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeManifestText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw new CompanionPetError(`${field} is required`, "INVALID_PET_PACKAGE", 422);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CompanionPetError(`${field} must be a string`, "INVALID_PET_PACKAGE", 422);
  }
  const text = value.trim();
  if (
    (required && !text)
    || text.length > maxLength
    || /[\u0000-\u001F\u007F-\u009F<>\u2028\u2029\u202A-\u202E\u2066-\u2069]/.test(text)
  ) {
    throw new CompanionPetError(`${field} contains unsafe text`, "INVALID_PET_PACKAGE", 422);
  }
  return text || undefined;
}

interface SafeSpritesheetPath {
  relativePath: string;
  installedName: "spritesheet.webp" | "spritesheet.png";
}

function normalizeSpritesheetSourcePath(value: unknown): SafeSpritesheetPath {
  const text = safeManifestText(value, "spritesheetPath", 240) ?? "spritesheet.webp";
  const portable = text.replaceAll("\\", "/");
  if (
    portable.startsWith("/")
    || /^[A-Za-z]:\//.test(portable)
    || portable.startsWith("//")
  ) {
    throw new CompanionPetError(
      "spritesheetPath must stay inside its pet folder",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (segment === ".") continue;
    if (
      !segment
      || segment === ".."
      || segment.length > 120
      || /[\u0000-\u001F\u007F<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment)
      || WINDOWS_DEVICE_PET_ID.test(segment)
    ) {
      throw new CompanionPetError(
        "spritesheetPath contains an unsafe path segment",
        "INVALID_PET_PACKAGE",
        422,
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0 || segments.length > 16) {
    throw new CompanionPetError("spritesheetPath is invalid", "INVALID_PET_PACKAGE", 422);
  }
  const lowerName = segments.at(-1)!.toLowerCase();
  const installedName = lowerName.endsWith(".png")
    ? "spritesheet.png"
    : lowerName.endsWith(".webp")
      ? "spritesheet.webp"
      : null;
  if (!installedName) {
    throw new CompanionPetError(
      "spritesheetPath must name a PNG or WebP file",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  return { relativePath: path.join(...segments), installedName };
}

function manifestInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CompanionPetError(`${field} must be a positive integer`, "INVALID_PET_PACKAGE", 422);
  }
  return value as number;
}

function normalizeFrame(
  value: unknown,
  requestedVersion: 1 | 2 | undefined,
): { frame: CompanionPetFrame; spriteVersionNumber: 1 | 2; frameCount: number } {
  let frame: CompanionPetFrame;
  if (value === undefined || value === null) {
    const rows = requestedVersion === 2 ? DEFAULT_ROWS_V2 : DEFAULT_ROWS_V1;
    frame = { width: FRAME_WIDTH, height: FRAME_HEIGHT, columns: DEFAULT_COLUMNS, rows };
  } else {
    if (!isPlainRecord(value)) {
      throw new CompanionPetError("frame must be an object", "INVALID_PET_PACKAGE", 422);
    }
    frame = {
      width: manifestInteger(value.width, "frame.width"),
      height: manifestInteger(value.height, "frame.height"),
      columns: manifestInteger(value.columns, "frame.columns"),
      rows: manifestInteger(value.rows, "frame.rows"),
    };
  }
  const atlasWidth = frame.width * frame.columns;
  const atlasHeight = frame.height * frame.rows;
  const frameCount = frame.columns * frame.rows;
  if (
    !Number.isSafeInteger(atlasWidth)
    || !Number.isSafeInteger(atlasHeight)
    || atlasWidth !== ATLAS_WIDTH
    || (atlasHeight !== ATLAS_HEIGHT_V1 && atlasHeight !== ATLAS_HEIGHT_V2)
  ) {
    throw new CompanionPetError(
      `frame grid must cover exactly ${ATLAS_WIDTH}x${ATLAS_HEIGHT_V1} or ${ATLAS_WIDTH}x${ATLAS_HEIGHT_V2}`,
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  if (!Number.isSafeInteger(frameCount) || frameCount > MAX_PET_FRAMES) {
    throw new CompanionPetError(
      `frame count must not exceed ${MAX_PET_FRAMES}`,
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  const spriteVersionNumber: 1 | 2 = atlasHeight === ATLAS_HEIGHT_V2 ? 2 : 1;
  if (requestedVersion !== undefined && requestedVersion !== spriteVersionNumber) {
    throw new CompanionPetError(
      "spriteVersionNumber does not match the frame grid",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  return { frame, spriteVersionNumber, frameCount };
}

function safeAnimationName(value: unknown, field: string): string {
  const name = safeManifestText(value, field, 80, true)!;
  if (name === "__proto__" || name === "prototype" || name === "constructor") {
    throw new CompanionPetError(`${field} is reserved`, "INVALID_PET_PACKAGE", 422);
  }
  return name;
}

function normalizeFrameIndices(value: unknown, frameCount: number, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANIMATION_FRAMES) {
    throw new CompanionPetError(
      `${label} must contain 1-${MAX_ANIMATION_FRAMES} frames`,
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  return value.map((frameIndex) => {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
      throw new CompanionPetError(
        `${label} references a frame outside the ${frameCount}-frame grid`,
        "INVALID_PET_PACKAGE",
        422,
      );
    }
    return frameIndex;
  });
}

function normalizeAnimation(
  value: unknown,
  frameCount: number,
  label: string,
): NormalizedPetAnimation {
  if (!isPlainRecord(value)) {
    throw new CompanionPetError(`${label} must be an object`, "INVALID_PET_PACKAGE", 422);
  }
  const isPioraNormalized = value.frameIndices !== undefined;
  const frameIndices = normalizeFrameIndices(
    isPioraNormalized ? value.frameIndices : value.frames,
    frameCount,
    `${label}.frames`,
  );
  const fallback = safeManifestText(value.fallback, `${label}.fallback`, 80) ?? "idle";
  safeAnimationName(fallback, `${label}.fallback`);

  if (isPioraNormalized) {
    if (!Array.isArray(value.durationsMs) || value.durationsMs.length !== frameIndices.length) {
      throw new CompanionPetError(
        `${label}.durationsMs must match its frame count`,
        "INVALID_PET_PACKAGE",
        422,
      );
    }
    const durationsMs = value.durationsMs.map((duration) => {
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_TIMER_DURATION_MS) {
        throw new CompanionPetError(
          `${label}.durationsMs contains an invalid duration`,
          "INVALID_PET_PACKAGE",
          422,
        );
      }
      return duration;
    });
    const loopStart = value.loopStart;
    if (loopStart !== null && typeof loopStart !== "number") {
      throw new CompanionPetError(`${label}.loopStart is invalid`, "INVALID_PET_PACKAGE", 422);
    }
    if (
      typeof loopStart === "number"
      && (!Number.isSafeInteger(loopStart) || loopStart < 0 || loopStart >= frameIndices.length)
    ) {
      throw new CompanionPetError(`${label}.loopStart is invalid`, "INVALID_PET_PACKAGE", 422);
    }
    return {
      frameIndices,
      durationsMs,
      loopStart,
      fallback,
    };
  }

  const fps = value.fps === undefined || value.fps === null ? 8 : value.fps;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0 || fps > MAX_ANIMATION_FPS) {
    throw new CompanionPetError(
      `${label}.fps must be finite and between 0 and ${MAX_ANIMATION_FPS}`,
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  if (value.loop !== undefined && value.loop !== null && typeof value.loop !== "boolean") {
    throw new CompanionPetError(`${label}.loop must be a boolean`, "INVALID_PET_PACKAGE", 422);
  }
  const duration = Math.min(MAX_TIMER_DURATION_MS, Math.max(1, Math.round(1000 / fps)));
  return {
    frameIndices,
    durationsMs: frameIndices.map(() => duration),
    loopStart: value.loop === false ? null : 0,
    fallback,
  };
}

function cloneDefaultAnimations(
  spriteVersionNumber: 1 | 2,
): Record<string, NormalizedPetAnimation> {
  const clone = Object.create(null) as Record<string, NormalizedPetAnimation>;
  for (const [name, animation] of Object.entries(defaultPetAnimations(spriteVersionNumber))) {
    clone[name] = normalizedAnimation(
      [...animation.frameIndices],
      [...animation.durationsMs],
      animation.loopStart,
      animation.fallback,
    );
  }
  return clone;
}

function normalizeAnimations(
  value: unknown,
  frameCount: number,
  spriteVersionNumber: 1 | 2,
): Record<string, NormalizedPetAnimation> {
  const animations = cloneDefaultAnimations(spriteVersionNumber);
  if (value !== undefined) {
    if (!isPlainRecord(value)) {
      throw new CompanionPetError("animations must be an object", "INVALID_PET_PACKAGE", 422);
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_ANIMATIONS) {
      throw new CompanionPetError(
        `animations must not contain more than ${MAX_ANIMATIONS} states`,
        "INVALID_PET_PACKAGE",
        422,
      );
    }
    for (const [rawName, animation] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      const name = safeAnimationName(rawName, "animation name");
      animations[name] = normalizeAnimation(animation, frameCount, `animation ${name}`);
    }
  }
  for (const [name, animation] of Object.entries(animations)) {
    normalizeFrameIndices(animation.frameIndices, frameCount, `animation ${name}.frames`);
    if (!Object.hasOwn(animations, animation.fallback)) {
      throw new CompanionPetError(
        `animation ${name} fallback ${animation.fallback} does not exist`,
        "INVALID_PET_PACKAGE",
        422,
      );
    }
  }
  if (!Object.hasOwn(animations, "idle")) {
    throw new CompanionPetError("animations must include idle", "INVALID_PET_PACKAGE", 422);
  }
  return animations;
}

const CODEX_SOURCE_KINDS = new Set<CodexPetSourceKind>([
  "codex-builtin-cache",
  "codex-custom",
  "codex-legacy-avatar",
]);

export function normalizePetManifest(value: unknown, folderId: string): NormalizedPetManifest {
  requireValidPetId(folderId);
  if (!isPlainRecord(value)) {
    throw new CompanionPetError("pet.json must contain a JSON object", "INVALID_PET_PACKAGE", 422);
  }

  const manifestId = safeManifestText(value.id, "id", 80);
  const rawVersion = value.spriteVersionNumber === null ? undefined : value.spriteVersionNumber;
  if (rawVersion !== undefined && rawVersion !== 1 && rawVersion !== 2) {
    throw new CompanionPetError(
      "spriteVersionNumber must be 1, 2, or omitted for v1",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  const { frame, spriteVersionNumber, frameCount } = normalizeFrame(
    value.frame,
    rawVersion as 1 | 2 | undefined,
  );
  const spritesheet = normalizeSpritesheetSourcePath(value.spritesheetPath);
  const displayName = safeManifestText(value.displayName, "displayName", 80)
    ?? safeManifestText(value.name, "name", 80)
    ?? manifestId
    ?? folderId;
  let origin: CodexPetSourceKind | undefined;
  if (value.origin !== undefined) {
    if (typeof value.origin !== "string" || !CODEX_SOURCE_KINDS.has(value.origin as CodexPetSourceKind)) {
      throw new CompanionPetError("origin is invalid", "INVALID_PET_PACKAGE", 422);
    }
    origin = value.origin as CodexPetSourceKind;
  }

  return {
    schemaVersion: 1,
    id: folderId,
    displayName: displayName!,
    description: safeManifestText(value.description, "description", 280),
    author: safeManifestText(value.author, "author", 120),
    spriteVersionNumber,
    spritesheetPath: spritesheet.installedName,
    frame,
    animations: normalizeAnimations(value.animations, frameCount, spriteVersionNumber),
    ...(origin ? { origin } : {}),
  };
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPng(bytes: Uint8Array): SpriteInspection | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let inspection: SpriteInspection | null = null;
  let sawImageData = false;
  let chunkCount = 0;
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_IMAGE_CONTAINER_CHUNKS) {
      throw new CompanionPetError("PNG spritesheet has too many chunks", "INVALID_PET_PACKAGE", 422);
    }
    const chunkSize = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const payload = offset + 8;
    const chunkEnd = payload + chunkSize + 4;
    if (chunkEnd > bytes.length) {
      throw new CompanionPetError("PNG spritesheet has a truncated chunk", "INVALID_PET_PACKAGE", 422);
    }
    if (!inspection) {
      if (offset !== 8 || type !== "IHDR" || chunkSize !== 13) {
        throw new CompanionPetError("PNG spritesheet has an invalid IHDR", "INVALID_PET_PACKAGE", 422);
      }
      inspection = {
        mimeType: "image/png",
        width: view.getUint32(payload, false),
        height: view.getUint32(payload + 4, false),
      };
    } else if (type === "IHDR") {
      throw new CompanionPetError("PNG spritesheet has multiple IHDR chunks", "INVALID_PET_PACKAGE", 422);
    }
    if (type === "IDAT" && chunkSize > 0) sawImageData = true;
    if (type === "IEND") {
      if (chunkSize !== 0 || !sawImageData || chunkEnd !== bytes.length) {
        throw new CompanionPetError("PNG spritesheet has an invalid ending", "INVALID_PET_PACKAGE", 422);
      }
      return inspection;
    }
    offset = chunkEnd;
  }
  throw new CompanionPetError("PNG spritesheet is missing image data or IEND", "INVALID_PET_PACKAGE", 422);
}

function inspectWebpImageChunk(
  bytes: Uint8Array,
  view: DataView,
  type: string,
  payload: number,
  chunkSize: number,
): SpriteInspection | null {
  if (type === "VP8L" && chunkSize >= 5 && bytes[payload] === 0x2f) {
    const b1 = bytes[payload + 1];
    const b2 = bytes[payload + 2];
    const b3 = bytes[payload + 3];
    const b4 = bytes[payload + 4];
    return {
      mimeType: "image/webp",
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  if (
    type === "VP8 "
    && chunkSize >= 10
    && bytes[payload + 3] === 0x9d
    && bytes[payload + 4] === 0x01
    && bytes[payload + 5] === 0x2a
  ) {
    return {
      mimeType: "image/webp",
      width: view.getUint16(payload + 6, true) & 0x3fff,
      height: view.getUint16(payload + 8, true) & 0x3fff,
    };
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): SpriteInspection | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredSize = view.getUint32(4, true) + 8;
  if (declaredSize > bytes.length) {
    throw new CompanionPetError("WebP spritesheet is truncated", "INVALID_PET_PACKAGE", 422);
  }
  if (declaredSize !== bytes.length) {
    throw new CompanionPetError("WebP spritesheet has trailing data", "INVALID_PET_PACKAGE", 422);
  }

  let offset = 12;
  let inspection: SpriteInspection | null = null;
  let sawImageData = false;
  let sawExtendedHeader = false;
  let chunkCount = 0;
  while (offset + 8 <= declaredSize) {
    chunkCount += 1;
    if (chunkCount > MAX_IMAGE_CONTAINER_CHUNKS) {
      throw new CompanionPetError("WebP spritesheet has too many chunks", "INVALID_PET_PACKAGE", 422);
    }
    const type = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + chunkSize > declaredSize) {
      throw new CompanionPetError("WebP spritesheet has an invalid chunk", "INVALID_PET_PACKAGE", 422);
    }
    if (type === "VP8X") {
      if (chunkSize !== 10 || inspection) {
        throw new CompanionPetError("WebP spritesheet has an invalid VP8X chunk", "INVALID_PET_PACKAGE", 422);
      }
      inspection = {
        mimeType: "image/webp",
        width: readUint24LE(bytes, payload + 4) + 1,
        height: readUint24LE(bytes, payload + 7) + 1,
      };
      sawExtendedHeader = true;
    }
    const frameInspection = inspectWebpImageChunk(bytes, view, type, payload, chunkSize);
    if (frameInspection) {
      if (
        inspection
        && (inspection.width !== frameInspection.width || inspection.height !== frameInspection.height)
      ) {
        throw new CompanionPetError("WebP canvas and frame dimensions do not match", "INVALID_PET_PACKAGE", 422);
      }
      inspection ??= frameInspection;
      sawImageData = true;
    }
    if (type === "ANMF") {
      if (!inspection || !sawExtendedHeader || chunkSize < 24) {
        throw new CompanionPetError("WebP spritesheet has an invalid animation frame", "INVALID_PET_PACKAGE", 422);
      }
      const frameX = readUint24LE(bytes, payload) * 2;
      const frameY = readUint24LE(bytes, payload + 3) * 2;
      const frameWidth = readUint24LE(bytes, payload + 6) + 1;
      const frameHeight = readUint24LE(bytes, payload + 9) + 1;
      if (frameX + frameWidth > inspection.width || frameY + frameHeight > inspection.height) {
        throw new CompanionPetError("WebP animation frame exceeds its canvas", "INVALID_PET_PACKAGE", 422);
      }
      const frameEnd = payload + chunkSize;
      let nestedOffset = payload + 16;
      let nestedImage: SpriteInspection | null = null;
      while (nestedOffset + 8 <= frameEnd) {
        chunkCount += 1;
        if (chunkCount > MAX_IMAGE_CONTAINER_CHUNKS) {
          throw new CompanionPetError("WebP spritesheet has too many chunks", "INVALID_PET_PACKAGE", 422);
        }
        const nestedType = ascii(bytes, nestedOffset, 4);
        const nestedSize = view.getUint32(nestedOffset + 4, true);
        const nestedPayload = nestedOffset + 8;
        if (nestedPayload + nestedSize > frameEnd) {
          throw new CompanionPetError("WebP animation frame is truncated", "INVALID_PET_PACKAGE", 422);
        }
        const candidateImage = inspectWebpImageChunk(
          bytes,
          view,
          nestedType,
          nestedPayload,
          nestedSize,
        );
        if (candidateImage) {
          if (nestedImage) {
            throw new CompanionPetError("WebP animation frame has multiple images", "INVALID_PET_PACKAGE", 422);
          }
          nestedImage = candidateImage;
        }
        nestedOffset = nestedPayload + nestedSize + (nestedSize % 2);
      }
      if (
        nestedOffset !== frameEnd
        || !nestedImage
        || nestedImage.width !== frameWidth
        || nestedImage.height !== frameHeight
      ) {
        throw new CompanionPetError("WebP animation frame is invalid", "INVALID_PET_PACKAGE", 422);
      }
      sawImageData = true;
    }
    offset = payload + chunkSize + (chunkSize % 2);
  }
  if (offset !== declaredSize) {
    throw new CompanionPetError("WebP spritesheet has invalid chunk padding", "INVALID_PET_PACKAGE", 422);
  }
  if (!inspection || !sawImageData) {
    throw new CompanionPetError("WebP spritesheet dimensions or image data were not found", "INVALID_PET_PACKAGE", 422);
  }
  return inspection;
}

export function inspectPetSpritesheetBytes(
  bytes: Uint8Array,
  fileName: string,
): SpriteInspection {
  const inspection = inspectPng(bytes) ?? inspectWebp(bytes);
  if (!inspection) {
    throw new CompanionPetError(
      "Spritesheet must contain PNG or WebP bytes",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  const expectedMime = fileName === "spritesheet.png" ? "image/png" : "image/webp";
  if (!ALLOWED_SPRITESHEETS.has(fileName) || inspection.mimeType !== expectedMime) {
    throw new CompanionPetError(
      "Spritesheet extension does not match its image bytes",
      "INVALID_PET_PACKAGE",
      422,
    );
  }
  return inspection;
}

function assertAtlasGeometry(
  inspection: SpriteInspection,
  manifest: Pick<NormalizedPetManifest, "frame" | "spriteVersionNumber">,
): void {
  const expectedWidth = manifest.frame.width * manifest.frame.columns;
  const expectedHeight = manifest.frame.height * manifest.frame.rows;
  if (inspection.width !== expectedWidth || inspection.height !== expectedHeight) {
    throw new CompanionPetError(
      `Pet v${manifest.spriteVersionNumber} spritesheet must be ${expectedWidth}x${expectedHeight}`,
      "INVALID_PET_PACKAGE",
      422,
    );
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasSameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasSameResolvedPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

/**
 * Read a package file through one descriptor and never allocate beyond the
 * declared bound. Path and descriptor identities are checked before and after
 * the read so a concurrent symlink/file swap is rejected rather than followed.
 */
function readBoundedRegularFile(
  root: string,
  fileName: string,
  maxBytes: number,
  label: string,
  immutableBundledResource = false,
): Buffer {
  const candidate = path.join(root, fileName);
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new CompanionPetError(
          `${label} path must not contain symbolic links`,
          "PET_ACCESS_DENIED",
          403,
        );
      }
    } catch (error) {
      if (error instanceof CompanionPetError) throw error;
      throw new CompanionPetError(`${label} is missing`, "INVALID_PET_PACKAGE", 422);
    }
  }
  let initialPathStats: fs.Stats;
  let realRoot: string;
  let initialRealFile: string;
  try {
    initialPathStats = fs.lstatSync(candidate);
    realRoot = fs.realpathSync(root);
    initialRealFile = fs.realpathSync(candidate);
  } catch {
    throw new CompanionPetError(`${label} is missing`, "INVALID_PET_PACKAGE", 422);
  }
  if (!initialPathStats.isFile() || initialPathStats.isSymbolicLink()) {
    throw new CompanionPetError(`${label} must be a regular file`, "PET_ACCESS_DENIED", 403);
  }
  if (!isContainedPath(realRoot, initialRealFile)) {
    throw new CompanionPetError(`${label} escapes its pet folder`, "PET_ACCESS_DENIED", 403);
  }
  if (initialPathStats.size <= 0 || initialPathStats.size > maxBytes) {
    throw new CompanionPetError(`${label} exceeds its allowed size`, "PET_TOO_LARGE", 413);
  }

  // Electron's ASAR layer reports virtual entry metadata for lstat(), while
  // fstat() observes the backing archive descriptor. Their inode/size values
  // therefore cannot pass the identity checks below. Piora-bundled pets are
  // immutable, checksum-verified release inputs, so read those entries only
  // after the same containment, symlink, type, and size checks above. Imported
  // or Codex-owned pets continue through the descriptor race defenses below.
  if (immutableBundledResource) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(candidate);
    } catch {
      throw new CompanionPetError(`${label} could not be read`, "PET_ACCESS_DENIED", 403);
    }
    if (bytes.byteLength !== initialPathStats.size || bytes.byteLength > maxBytes) {
      throw new CompanionPetError(`${label} changed while being read`, "INVALID_PET_PACKAGE", 422);
    }
    return bytes;
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new CompanionPetError(`${label} could not be opened safely`, "PET_ACCESS_DENIED", 403);
  }

  try {
    const initialDescriptorStats = fs.fstatSync(descriptor);
    if (initialDescriptorStats.size <= 0 || initialDescriptorStats.size > maxBytes) {
      throw new CompanionPetError(`${label} exceeds its allowed size`, "PET_TOO_LARGE", 413);
    }
    let openedRealFile: string;
    let openedPathStats: fs.Stats;
    try {
      openedRealFile = fs.realpathSync(candidate);
      openedPathStats = fs.lstatSync(candidate);
    } catch {
      throw new CompanionPetError(`${label} changed while being opened`, "PET_ACCESS_DENIED", 403);
    }
    if (
      !initialDescriptorStats.isFile()
      || !hasSameFileIdentity(initialPathStats, initialDescriptorStats)
      || initialPathStats.size !== initialDescriptorStats.size
      || initialPathStats.mtimeMs !== initialDescriptorStats.mtimeMs
      || !hasSameFileIdentity(openedPathStats, initialDescriptorStats)
      || openedPathStats.isSymbolicLink()
      || !isContainedPath(realRoot, openedRealFile)
      || !hasSameResolvedPath(initialRealFile, openedRealFile)
    ) {
      throw new CompanionPetError(`${label} changed while being opened`, "PET_ACCESS_DENIED", 403);
    }

    const buffer = Buffer.allocUnsafe(initialDescriptorStats.size + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = fs.readSync(
        descriptor,
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }

    const finalDescriptorStats = fs.fstatSync(descriptor);
    let finalPathStats: fs.Stats;
    let finalRealFile: string;
    try {
      finalPathStats = fs.lstatSync(candidate);
      finalRealFile = fs.realpathSync(candidate);
    } catch {
      throw new CompanionPetError(`${label} changed while being read`, "PET_ACCESS_DENIED", 403);
    }
    if (
      total !== initialDescriptorStats.size
      || total > maxBytes
      || finalDescriptorStats.size !== initialDescriptorStats.size
      || finalDescriptorStats.mtimeMs !== initialDescriptorStats.mtimeMs
      || !hasSameFileIdentity(initialDescriptorStats, finalDescriptorStats)
      || !hasSameFileIdentity(finalPathStats, finalDescriptorStats)
      || finalPathStats.isSymbolicLink()
      || !isContainedPath(realRoot, finalRealFile)
      || !hasSameResolvedPath(initialRealFile, finalRealFile)
    ) {
      throw new CompanionPetError(`${label} changed while being read`, "INVALID_PET_PACKAGE", 422);
    }
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    fs.closeSync(descriptor);
  }
}

function petFromManifest(
  manifest: NormalizedPetManifest,
  source: "codex" | "piora",
  sourceKind: CompanionPetSourceKind,
  installed: boolean,
): CompanionPet {
  const width = manifest.frame.width * manifest.frame.columns;
  const height = manifest.frame.height * manifest.frame.rows;
  const origin = sourceKind === "piora-installed" || sourceKind === "piora-bundled"
    ? manifest.origin
    : sourceKind;
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    spriteVersionNumber: manifest.spriteVersionNumber,
    spritesheetPath: manifest.spritesheetPath,
    atlasUrl: sourceKind === "piora-bundled"
      ? `${BUNDLED_COMPANION_PETS_PUBLIC_PATH}/${encodeURIComponent(manifest.id)}/${manifest.spritesheetPath}`
      : source === "piora"
        ? `/api/companion-pets/${encodeURIComponent(manifest.id)}/spritesheet`
        : `/api/companion-pets/${encodeURIComponent(manifest.id)}/spritesheet?sourceKind=${encodeURIComponent(sourceKind)}`,
    width,
    height,
    frame: { ...manifest.frame },
    columns: manifest.frame.columns,
    rows: manifest.frame.rows,
    frameWidth: manifest.frame.width,
    frameHeight: manifest.frame.height,
    frameCount: manifest.frame.columns * manifest.frame.rows,
    states: petAnimationStates(manifest.animations, manifest.frame.columns),
    source,
    sourceKind,
    sourceKey: `${sourceKind}:${manifest.id}`,
    ...(origin ? { origin } : {}),
    installed,
  };
}

function validatePetPackage(
  root: string,
  id: string,
  source: "codex" | "piora",
  sourceKind: CompanionPetSourceKind,
  installed: boolean,
  manifestFileName = "pet.json",
): ValidatedPetPackage {
  requireValidPetId(id);
  let rootPathStats: fs.Stats;
  let rootTargetStats: fs.Stats;
  let rootReal: string;
  try {
    rootPathStats = fs.lstatSync(root);
    rootTargetStats = fs.statSync(root);
    rootReal = fs.realpathSync(root);
  } catch {
    throw new CompanionPetError("Pet data directory was not found", "PET_NOT_FOUND", 404);
  }
  if (!rootTargetStats.isDirectory()) {
    throw new CompanionPetError("Pet data root is not a directory", "PET_ACCESS_DENIED", 403);
  }
  if ((sourceKind === "piora-installed" || sourceKind === "piora-bundled") && rootPathStats.isSymbolicLink()) {
    throw new CompanionPetError(
      "Installed pet data root must not be a symbolic link",
      "PET_ACCESS_DENIED",
      403,
    );
  }
  const petDirectory = path.join(rootReal, id);
  let directoryStats: fs.Stats;
  try {
    directoryStats = fs.lstatSync(petDirectory);
  } catch {
    throw new CompanionPetError("Pet package was not found", "PET_NOT_FOUND", 404);
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new CompanionPetError("Pet package must be a regular directory", "PET_ACCESS_DENIED", 403);
  }
  const realPetDirectory = fs.realpathSync(petDirectory);
  if (!isContainedPath(rootReal, realPetDirectory)) {
    throw new CompanionPetError("Pet package escapes its data directory", "PET_ACCESS_DENIED", 403);
  }

  const manifestBytes = readBoundedRegularFile(
    realPetDirectory,
    manifestFileName,
    sourceKind === "piora-installed" || sourceKind === "piora-bundled"
      ? PET_INSTALLED_MANIFEST_MAX_BYTES
      : PET_MANIFEST_MAX_BYTES,
    manifestFileName,
    sourceKind === "piora-bundled",
  );
  let parsed: unknown;
  try {
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    parsed = JSON.parse(manifestText);
  } catch {
    throw new CompanionPetError(`${manifestFileName} is invalid JSON`, "INVALID_PET_PACKAGE", 422);
  }
  const manifest = normalizePetManifest(parsed, id);
  const sourceSpritesheet = normalizeSpritesheetSourcePath(
    isPlainRecord(parsed) ? parsed.spritesheetPath : undefined,
  );
  const spritesheetBytes = readBoundedRegularFile(
    realPetDirectory,
    sourceSpritesheet.relativePath,
    PET_SPRITESHEET_MAX_BYTES,
    "spritesheet",
    sourceKind === "piora-bundled",
  );
  const inspection = inspectPetSpritesheetBytes(spritesheetBytes, sourceSpritesheet.installedName);
  assertAtlasGeometry(inspection, manifest);

  return {
    manifest,
    pet: petFromManifest(manifest, source, sourceKind, installed),
    spritesheetBytes,
    mimeType: inspection.mimeType,
    sourceKind,
  };
}

function getCodexHomeDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(getRuntimeHomeDirectory(environment), ".codex");
}

export function getCodexPetsDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  return path.join(getCodexHomeDirectory(environment), "pets");
}

export function getCodexLegacyAvatarsDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  return path.join(getCodexHomeDirectory(environment), "avatars");
}

export function getCodexBuiltinPetsAssetsDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  return path.join(getCodexHomeDirectory(environment), "cache", "tui-pets", "v1", "assets");
}

export function getPioraPetsDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  return path.join(getRuntimeAgentDataDirectory(environment), "piora", "pets");
}

export function getBundledPioraPetsDirectory(
  environment: CompanionPetEnvironment = process.env,
): string {
  return path.join(firstPartyRuntimeRoot(environment), "public", "companion-pets", "bundled");
}

function listPetPackages(
  root: string,
  sourceKind: CompanionPetSourceKind,
  installedSourceKeys: ReadonlySet<string>,
  manifestFileName = "pet.json",
): { pets: CompanionPet[]; diagnostics: CompanionPetDiagnostic[]; available: boolean } {
  const source = sourceKind === "piora-installed" || sourceKind === "piora-bundled" ? "piora" : "codex";
  const scope = source === "codex" ? "source" : "installed";
  let rootPathStats: fs.Stats;
  let rootStats: fs.Stats;
  try {
    rootPathStats = fs.lstatSync(root);
    rootStats = fs.statSync(root);
  } catch {
    return { pets: [], diagnostics: [], available: false };
  }
  if ((sourceKind === "piora-installed" || sourceKind === "piora-bundled") && rootPathStats.isSymbolicLink()) {
    return {
      pets: [],
      diagnostics: [{ scope, message: "Installed pet root must not be a symbolic link" }],
      available: false,
    };
  }
  if (!rootStats.isDirectory()) {
    return {
      pets: [],
      diagnostics: [{ scope, message: "Pet root is not a directory" }],
      available: false,
    };
  }

  const pets: CompanionPet[] = [];
  const diagnostics: CompanionPetDiagnostic[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return {
      pets: [],
      diagnostics: [{ scope, message: "Pet root could not be read" }],
      available: false,
    };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidPetId(entry.name)) continue;
    try {
      const validated = validatePetPackage(
        root,
        entry.name,
        source,
        sourceKind,
        sourceKind === "piora-installed" || sourceKind === "piora-bundled"
          || installedSourceKeys.has(`${sourceKind}:${entry.name}`)
          || installedSourceKeys.has(`*:${entry.name}`),
        manifestFileName,
      );
      pets.push(validated.pet);
    } catch (error) {
      diagnostics.push({
        scope,
        id: entry.name,
        message: error instanceof CompanionPetError ? error.message : "Pet package could not be read",
      });
    }
  }
  pets.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { pets, diagnostics, available: true };
}

function validateBuiltinPet(
  root: string,
  entry: CodexBuiltinPetCatalogEntry,
  installed: boolean,
): ValidatedPetPackage {
  const manifest = normalizePetManifest({
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    spritesheetPath: entry.spritesheetFile,
  }, entry.id);
  const spritesheetBytes = readBoundedRegularFile(
    root,
    entry.spritesheetFile,
    PET_SPRITESHEET_MAX_BYTES,
    "spritesheet",
  );
  const inspection = inspectPetSpritesheetBytes(spritesheetBytes, "spritesheet.webp");
  assertAtlasGeometry(inspection, manifest);
  const sourceKind: CompanionPetSourceKind = "codex-builtin-cache";
  return {
    manifest,
    pet: petFromManifest(manifest, "codex", sourceKind, installed),
    spritesheetBytes,
    mimeType: inspection.mimeType,
    sourceKind,
  };
}

function listBuiltinPets(
  root: string,
  installedSourceKeys: ReadonlySet<string>,
): { pets: CompanionPet[]; diagnostics: CompanionPetDiagnostic[]; available: boolean } {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return { pets: [], diagnostics: [], available: false };
  }
  if (!stats.isDirectory()) {
    return {
      pets: [],
      diagnostics: [{ scope: "source", message: "Codex built-in pet cache is not a directory" }],
      available: false,
    };
  }
  const pets: CompanionPet[] = [];
  const diagnostics: CompanionPetDiagnostic[] = [];
  for (const entry of CODEX_BUILTIN_PET_CATALOG) {
    const file = path.join(root, entry.spritesheetFile);
    if (!fs.existsSync(file)) continue;
    try {
      pets.push(validateBuiltinPet(
        root,
        entry,
        installedSourceKeys.has(`codex-builtin-cache:${entry.id}`)
          || installedSourceKeys.has(`*:${entry.id}`),
      ).pet);
    } catch (error) {
      diagnostics.push({
        scope: "source",
        id: entry.id,
        message: error instanceof CompanionPetError ? error.message : "Built-in pet could not be read",
      });
    }
  }
  return { pets, diagnostics, available: true };
}

export function listCompanionPets(
  environment: CompanionPetEnvironment = process.env,
): CompanionPetsResponse {
  const bundledResult = listPetPackages(
    getBundledPioraPetsDirectory(environment),
    "piora-bundled",
    new Set(),
  );
  const installedResult = listPetPackages(
    getPioraPetsDirectory(environment),
    "piora-installed",
    new Set(),
  );
  const installedById = new Map(bundledResult.pets.map((pet) => [pet.id, pet]));
  for (const pet of installedResult.pets) installedById.set(pet.id, pet);
  const modelsResult = listCompanionModels(environment);
  for (const pet of modelsResult.pets) {
    if (!installedById.has(pet.id)) installedById.set(pet.id, pet);
  }
  const installed = [...installedById.values()].sort((left, right) => (
    left.displayName.localeCompare(right.displayName)
  ));
  const installedSourceKeys = new Set(installed.map((pet) => (
    `${pet.origin ?? "*"}:${pet.id}`
  )));
  const builtinResult = listBuiltinPets(
    getCodexBuiltinPetsAssetsDirectory(environment),
    installedSourceKeys,
  );
  const customResult = listPetPackages(
    getCodexPetsDirectory(environment),
    "codex-custom",
    installedSourceKeys,
  );
  const legacyResult = listPetPackages(
    getCodexLegacyAvatarsDirectory(environment),
    "codex-legacy-avatar",
    installedSourceKeys,
    "avatar.json",
  );
  const sources = [
    ...builtinResult.pets,
    ...customResult.pets,
    ...legacyResult.pets,
  ].sort((left, right) => left.displayName.localeCompare(right.displayName));
  return {
    codexSourceAvailable: builtinResult.available || customResult.available || legacyResult.available,
    sources,
    installed,
    diagnostics: [
      ...builtinResult.diagnostics,
      ...customResult.diagnostics,
      ...legacyResult.diagnostics,
      ...bundledResult.diagnostics,
      ...installedResult.diagnostics,
      ...modelsResult.diagnostics,
    ],
  };
}

function syncFile(file: string): void {
  // Windows rejects FlushFileBuffers for a read-only handle. Open the freshly
  // written staging file read/write so fsync works on every supported OS.
  const descriptor = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectReplaceableDirectory(directory: string): fs.Stats | null {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CompanionPetError(
      "Installed pet destination could not be inspected",
      "PET_ACCESS_DENIED",
      403,
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CompanionPetError(
      "Installed pet destination is not a regular directory",
      "PET_ACCESS_DENIED",
      403,
    );
  }
  return stats;
}

function assertDirectorySnapshot(
  directory: string,
  expected: fs.Stats | null,
  label: string,
): fs.Stats | null {
  const current = inspectReplaceableDirectory(directory);
  if (
    (expected === null && current !== null)
    || (expected !== null && (current === null || !hasSameFileIdentity(expected, current)))
  ) {
    throw new CompanionPetError(`${label} changed during import`, "PET_ACCESS_DENIED", 403);
  }
  return current;
}

function removeOwnedDirectory(directory: string, expected: fs.Stats): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(directory);
  } catch {
    return;
  }
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || !hasSameFileIdentity(expected, current)
  ) {
    return;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

function loadCodexSourcePet(
  id: string,
  environment: CompanionPetEnvironment,
  requestedSourceKind?: CodexPetSourceKind,
): ValidatedPetPackage {
  if (requestedSourceKind !== undefined && !CODEX_SOURCE_KINDS.has(requestedSourceKind)) {
    throw new CompanionPetError("Pet source is invalid", "INVALID_PET_SOURCE", 400);
  }
  const trySource = (sourceKind: CodexPetSourceKind): ValidatedPetPackage | null => {
    if (sourceKind === "codex-builtin-cache") {
      const catalogEntry = CODEX_BUILTIN_PET_CATALOG.find((entry) => entry.id === id);
      if (!catalogEntry) return null;
      const root = getCodexBuiltinPetsAssetsDirectory(environment);
      if (!fs.existsSync(path.join(root, catalogEntry.spritesheetFile))) return null;
      return validateBuiltinPet(root, catalogEntry, false);
    }
    const root = sourceKind === "codex-custom"
      ? getCodexPetsDirectory(environment)
      : getCodexLegacyAvatarsDirectory(environment);
    const manifestFileName = sourceKind === "codex-custom" ? "pet.json" : "avatar.json";
    if (!fs.existsSync(path.join(root, id, manifestFileName))) return null;
    return validatePetPackage(root, id, "codex", sourceKind, false, manifestFileName);
  };

  if (requestedSourceKind) {
    const source = trySource(requestedSourceKind);
    if (source) return source;
    throw new CompanionPetError("Codex pet source was not found", "PET_NOT_FOUND", 404);
  }

  // Preserve the old API's custom-pet behavior when callers have not yet
  // adopted sourceKind, then fall back to other local Codex sources.
  for (const sourceKind of [
    "codex-custom",
    "codex-builtin-cache",
    "codex-legacy-avatar",
  ] as const) {
    const source = trySource(sourceKind);
    if (source) return source;
  }
  throw new CompanionPetError("Codex pet source was not found", "PET_NOT_FOUND", 404);
}

export function readCodexPetSpritesheet(
  id: string,
  sourceKind: CodexPetSourceKind,
  environment: CompanionPetEnvironment = process.env,
): { bytes: Buffer; mimeType: "image/png" | "image/webp"; pet: CompanionPet } {
  const validated = loadCodexSourcePet(id, environment, sourceKind);
  return {
    bytes: validated.spritesheetBytes,
    mimeType: validated.mimeType,
    pet: validated.pet,
  };
}

function installValidatedPet(
  source: ValidatedPetPackage,
  environment: CompanionPetEnvironment = process.env,
): { pet: CompanionPet; replaced: boolean } {
  const id = source.manifest.id;
  requireValidPetId(id);
  // validatePetPackage returns the exact bytes read from its verified file
  // descriptor, so no attacker-controlled pathname is reopened for the copy.
  const spritesheetBytes = source.spritesheetBytes;

  const configuredInstallRoot = getPioraPetsDirectory(environment);
  try {
    fs.mkdirSync(configuredInstallRoot, { recursive: true, mode: 0o700 });
  } catch {
    throw new CompanionPetError("Pet install directory could not be created", "PET_IMPORT_FAILED", 500);
  }
  let installRootStats: fs.Stats;
  let installRoot: string;
  try {
    installRootStats = fs.lstatSync(configuredInstallRoot);
    installRoot = fs.realpathSync(configuredInstallRoot);
  } catch {
    throw new CompanionPetError("Pet install directory could not be opened", "PET_IMPORT_FAILED", 500);
  }
  if (!installRootStats.isDirectory() || installRootStats.isSymbolicLink()) {
    throw new CompanionPetError(
      "Pet install directory must be a regular directory",
      "PET_ACCESS_DENIED",
      403,
    );
  }
  const destination = path.join(installRoot, id);
  if (!isContainedPath(installRoot, destination)) {
    throw new CompanionPetError("Invalid pet destination", "PET_ACCESS_DENIED", 403);
  }
  const destinationSnapshot = inspectReplaceableDirectory(destination);

  const staging = path.join(installRoot, `.import-${id}-${randomUUID()}`);
  const backup = path.join(installRoot, `.backup-${id}-${randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  const stagingSnapshot = fs.lstatSync(staging);
  let movedExisting = false;
  let installed = false;
  let stagedPet: CompanionPet | null = null;
  const replaced = destinationSnapshot !== null;
  try {
    const manifestFile = path.join(staging, "pet.json");
    const spritesheetFile = path.join(staging, source.manifest.spritesheetPath);
    const installedManifest: NormalizedPetManifest = {
      ...source.manifest,
      origin: source.sourceKind as CodexPetSourceKind,
    };
    const installedManifestPayload = `${JSON.stringify(installedManifest)}\n`;
    if (Buffer.byteLength(installedManifestPayload, "utf8") > PET_INSTALLED_MANIFEST_MAX_BYTES) {
      throw new CompanionPetError(
        "Normalized pet manifest is too large",
        "PET_TOO_LARGE",
        413,
      );
    }
    fs.writeFileSync(manifestFile, installedManifestPayload, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(spritesheetFile, spritesheetBytes, { flag: "wx", mode: 0o600 });
    syncFile(manifestFile);
    syncFile(spritesheetFile);

    const stagedManifestBytes = readBoundedRegularFile(
      staging,
      "pet.json",
      PET_INSTALLED_MANIFEST_MAX_BYTES,
      "pet.json",
    );
    let stagedManifestValue: unknown;
    try {
      stagedManifestValue = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(stagedManifestBytes),
      );
    } catch {
      throw new CompanionPetError("Staged pet manifest is invalid", "PET_IMPORT_FAILED", 500);
    }
    const stagedManifest = normalizePetManifest(stagedManifestValue, id);
    const stagedSpritesheetBytes = readBoundedRegularFile(
      staging,
      stagedManifest.spritesheetPath,
      PET_SPRITESHEET_MAX_BYTES,
      "spritesheet",
    );
    const stagedInspection = inspectPetSpritesheetBytes(
      stagedSpritesheetBytes,
      stagedManifest.spritesheetPath,
    );
    assertAtlasGeometry(stagedInspection, stagedManifest);
    if (!stagedSpritesheetBytes.equals(spritesheetBytes)) {
      throw new CompanionPetError("Staged spritesheet verification failed", "PET_IMPORT_FAILED", 500);
    }
    stagedPet = petFromManifest(stagedManifest, "piora", "piora-installed", true);

    assertDirectorySnapshot(destination, destinationSnapshot, "Installed pet destination");
    if (destinationSnapshot) {
      fs.renameSync(destination, backup);
      movedExisting = true;
      assertDirectorySnapshot(backup, destinationSnapshot, "Installed pet backup");
    }
    fs.renameSync(staging, destination);
    assertDirectorySnapshot(destination, stagingSnapshot, "Installed pet destination");
    installed = true;
  } catch (error) {
    const currentDestination = inspectReplaceableDirectory(destination);
    const currentBackup = inspectReplaceableDirectory(backup);
    if (
      !installed
      && movedExisting
      && currentDestination === null
      && destinationSnapshot
      && currentBackup
      && hasSameFileIdentity(destinationSnapshot, currentBackup)
    ) {
      try {
        fs.renameSync(backup, destination);
        movedExisting = false;
      } catch {
        // Keep the backup for manual recovery rather than deleting user data.
      }
    }
    if (error instanceof CompanionPetError) throw error;
    throw new CompanionPetError("Pet import failed", "PET_IMPORT_FAILED", 500);
  } finally {
    try {
      removeOwnedDirectory(staging, stagingSnapshot);
    } catch {
      // Safe dot-prefixed staging data can be retried on a later cleanup.
    }
    // Once the new directory is in place, a failed backup cleanup must not
    // turn a successful atomic replacement into an API failure.
    if (installed && destinationSnapshot) {
      try {
        removeOwnedDirectory(backup, destinationSnapshot);
      } catch {
        // A dot-prefixed recovery copy is safer than deleting data after an
        // antivirus/indexer temporarily holds a file open on Windows.
      }
    }
  }

  if (!stagedPet) {
    throw new CompanionPetError("Pet import failed", "PET_IMPORT_FAILED", 500);
  }
  return { pet: stagedPet, replaced };
}

export function importCodexPet(
  id: string,
  environment: CompanionPetEnvironment = process.env,
  sourceKind?: CodexPetSourceKind,
): { pet: CompanionPet; replaced: boolean } {
  requireValidPetId(id);
  return installValidatedPet(loadCodexSourcePet(id, environment, sourceKind), environment);
}

type SizedZipObject = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
  unsafeOriginalName?: string;
};

function assertSafeArchiveEntry(entry: SizedZipObject): void {
  const originalName = entry.unsafeOriginalName ?? entry.name;
  const normalized = originalName.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    originalName.includes("\\")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new CompanionPetError("Pet archive contains an unsafe path", "INVALID_PET_PACKAGE", 422);
  }
}

async function readArchiveEntryWithinLimit(
  entry: SizedZipObject,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const declaredSize = entry._data?.uncompressedSize;
  if (typeof declaredSize === "number" && declaredSize > maxBytes) {
    throw new CompanionPetError(`${label} is too large`, "PET_TOO_LARGE", 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolveRead, rejectRead) => {
    const stream = entry.nodeStream("nodebuffer");
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      rejectRead(error);
    };
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(new CompanionPetError(`${label} is too large`, "PET_TOO_LARGE", 413));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", () => fail(
      new CompanionPetError(`Could not read ${label}`, "INVALID_PET_PACKAGE", 422),
    ));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolveRead();
    });
    stream.resume();
  });
  return Buffer.concat(chunks, total);
}

function archiveFallbackPetId(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return isValidPetId(base) ? base : `pet-${randomUUID().slice(0, 8)}`;
}

export async function importCodexPetArchive(
  archiveBytes: Buffer,
  fileName: string,
  environment: CompanionPetEnvironment = process.env,
): Promise<{ pet: CompanionPet; replaced: boolean }> {
  if (archiveBytes.byteLength === 0) {
    throw new CompanionPetError("Pet archive is empty", "INVALID_PET_PACKAGE", 422);
  }
  if (archiveBytes.byteLength > PET_ARCHIVE_MAX_BYTES) {
    throw new CompanionPetError("Pet archive is too large", "PET_TOO_LARGE", 413);
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(archiveBytes, { createFolders: false });
  } catch {
    throw new CompanionPetError("Pet archive is not a valid ZIP file", "INVALID_PET_PACKAGE", 422);
  }
  const entries = Object.values(archive.files) as SizedZipObject[];
  if (entries.length === 0 || entries.length > PET_ARCHIVE_MAX_ENTRIES) {
    throw new CompanionPetError("Pet archive contains too many entries", "INVALID_PET_PACKAGE", 422);
  }
  entries.forEach(assertSafeArchiveEntry);

  const manifestCandidates = entries
    .filter((entry) => !entry.dir && /(^|\/)(pet|avatar)\.json$/i.test(entry.name))
    .sort((left, right) => left.name.split("/").length - right.name.split("/").length);
  const manifestEntry = manifestCandidates[0];
  if (!manifestEntry) {
    throw new CompanionPetError("Pet archive must contain pet.json", "INVALID_PET_PACKAGE", 422);
  }
  const manifestBytes = await readArchiveEntryWithinLimit(
    manifestEntry,
    PET_MANIFEST_MAX_BYTES,
    path.basename(manifestEntry.name),
  );
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new CompanionPetError("Pet manifest is invalid JSON", "INVALID_PET_PACKAGE", 422);
  }
  const manifest = normalizePetManifest(parsedManifest, archiveFallbackPetId(fileName));
  const sourceSpritesheet = normalizeSpritesheetSourcePath(
    isPlainRecord(parsedManifest) ? parsedManifest.spritesheetPath : undefined,
  );
  const manifestDirectory = path.posix.dirname(manifestEntry.name);
  const sourcePath = manifestDirectory === "."
    ? sourceSpritesheet.relativePath
    : `${manifestDirectory}/${sourceSpritesheet.relativePath}`;
  const spritesheetEntry = entries.find((entry) => !entry.dir && entry.name === sourcePath);
  if (!spritesheetEntry) {
    throw new CompanionPetError("Pet archive is missing its spritesheet", "INVALID_PET_PACKAGE", 422);
  }
  const spritesheetBytes = await readArchiveEntryWithinLimit(
    spritesheetEntry,
    PET_SPRITESHEET_MAX_BYTES,
    "spritesheet",
  );
  const inspection = inspectPetSpritesheetBytes(spritesheetBytes, sourceSpritesheet.installedName);
  assertAtlasGeometry(inspection, manifest);
  const sourceKind: CodexPetSourceKind = manifestEntry.name.toLowerCase().endsWith("avatar.json")
    ? "codex-legacy-avatar"
    : "codex-custom";
  return installValidatedPet({
    manifest,
    pet: petFromManifest(manifest, "codex", sourceKind, false),
    spritesheetBytes,
    mimeType: inspection.mimeType,
    sourceKind,
  }, environment);
}

export function readInstalledPetSpritesheet(
  id: string,
  environment: CompanionPetEnvironment = process.env,
): { bytes: Buffer; mimeType: "image/png" | "image/webp"; pet: CompanionPet } {
  requireValidPetId(id);
  const installRoot = getPioraPetsDirectory(environment);
  if (!fs.existsSync(installRoot)) {
    throw new CompanionPetError("Installed pet was not found", "PET_NOT_FOUND", 404);
  }
  const validated = validatePetPackage(
    installRoot,
    id,
    "piora",
    "piora-installed",
    true,
  );
  return {
    bytes: validated.spritesheetBytes,
    mimeType: validated.mimeType,
    pet: validated.pet,
  };
}
