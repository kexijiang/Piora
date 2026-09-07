import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const executable = process.argv[2];
const frames = resolve(process.argv[3] ?? ".verification/polaris");
if (!executable) throw new Error("Usage: node scripts/encode-startup-video.mjs <ffmpeg executable> [frame directory]");
const destination = resolve("desktop/build/startup");
mkdirSync(destination, { recursive: true });
for (let frame = 1; frame <= 192; frame++) {
  if (!existsSync(join(frames, `frame-${String(frame).padStart(4, "0")}.png`))) throw new Error(`Missing frame ${frame}`);
}
function ffmpeg(args) {
  const result = spawnSync(executable, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`FFmpeg failed: ${result.status}`);
}
ffmpeg(["-framerate", "24", "-i", join(frames, "frame-%04d.png"), "-frames:v", "192", "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(destination, "polaris-rover.mp4")]);
ffmpeg(["-i", join(frames, "frame-0001.png"), "-frames:v", "1", "-q:v", "3", join(destination, "polaris-rover.jpg")]);
copyFileSync(join(frames, "polaris-rover.blend"), join(destination, "polaris-rover.blend"));
const files = Object.fromEntries(["polaris-rover.mp4", "polaris-rover.jpg", "polaris-rover.blend"].map((name) => {
  const bytes = readFileSync(join(destination, name));
  if (bytes.length > (name.endsWith("mp4") ? 12_000_000 : name.endsWith("jpg") ? 1_000_000 : 10_000_000)) throw new Error(`Startup media exceeds its size budget: ${name}`);
  return [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
}));
writeFileSync(join(destination, "manifest.json"), `${JSON.stringify({ version: 1, renderer: "Blender 5.2.1 LTS / EEVEE", width: 1280, height: 720, fps: 24, frames: 192, durationSeconds: 8, audio: false, files }, null, 2)}\n`);
console.log(JSON.stringify(files));
