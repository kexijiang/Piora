import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const executable = process.argv[2];
const frames = resolve(process.argv[3] ?? ".verification/polaris");
if (!executable) throw new Error("Usage: node scripts/encode-startup-video.mjs <ffmpeg executable> [render directory] [destination]");
const destination = resolve(process.argv[4] ?? "desktop/build/startup");
const imported = existsSync(join(frames, "render_config.json"));
const config = imported ? JSON.parse(readFileSync(join(frames, "render_config.json"), "utf8")) : null;
const validationPath = join(frames, "blender-validation.json");
const blenderVersion = existsSync(validationPath) ? JSON.parse(readFileSync(validationPath, "utf8")).blender : null;
const fps = config?.fps ?? 24;
const frameCount = config ? Math.round(config.duration * fps) : 192;
if (!Number.isInteger(fps) || fps < 12 || fps > 120 || frameCount !== fps * 8) throw new Error("Startup media must be exactly eight seconds at a valid frame rate");
const pattern = imported ? join(frames, "frames", "frame_%04d.png") : join(frames, "frame-%04d.png");
const framePath = (frame) => pattern.replace("%04d", String(frame).padStart(4, "0"));
const blendPath = join(frames, imported ? "piora_polaris_2076.blend" : "polaris-rover.blend");
if (!existsSync(blendPath)) throw new Error("Missing editable Blender scene");
mkdirSync(destination, { recursive: true });
let width;
let height;
for (let frame = 1; frame <= frameCount; frame++) {
  if (!existsSync(framePath(frame))) throw new Error(`Missing frame ${frame}`);
  const png = readFileSync(framePath(frame));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Invalid PNG frame ${frame}`);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  width ??= w;
  height ??= h;
  if (w !== width || h !== height || w % 2 || h % 2) throw new Error(`Inconsistent or odd frame dimensions at ${frame}`);
}
function ffmpeg(args) {
  const result = spawnSync(executable, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`FFmpeg failed: ${result.status}`);
}
ffmpeg(["-framerate", String(fps), "-i", pattern, "-frames:v", String(frameCount), "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(destination, "polaris-rover.mp4")]);
// The new film opens from black: use the side-logo shot for a useful static fallback.
const posterFrame = imported ? Math.round((frameCount - 1) * .49) + 1 : 1;
ffmpeg(["-i", framePath(posterFrame), "-frames:v", "1", "-q:v", "3", join(destination, "polaris-rover.jpg")]);
copyFileSync(blendPath, join(destination, "polaris-rover.blend"));
const files = Object.fromEntries(["polaris-rover.mp4", "polaris-rover.jpg", "polaris-rover.blend"].map((name) => {
  const bytes = readFileSync(join(destination, name));
  if (bytes.length > (name.endsWith("mp4") ? 12_000_000 : name.endsWith("jpg") ? 1_000_000 : 10_000_000)) throw new Error(`Startup media exceeds its size budget: ${name}`);
  return [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
}));
writeFileSync(join(destination, "manifest.json"), `${JSON.stringify({ version: 2, renderer: `Blender ${blenderVersion ?? (imported ? "(version not recorded)" : "5.2.1 LTS")} / ${config?.engine ?? "EEVEE"}`, width, height, fps, frames: frameCount, durationSeconds: 8, posterFrame, audio: false, files }, null, 2)}\n`);
console.log(JSON.stringify(files));
