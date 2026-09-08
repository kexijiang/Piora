# Polaris Expedition / PX-06 / 2076

The active film uses the scene script supplied by the project owner and adapted
for Blender 5.2.1 LTS. It depicts a fictional ice-rock world in the direction of
Polaris. The rover, terrain, lettering, materials and effects are procedural;
no downloaded models, textures or fonts are used.

- `polaris-rover.mp4`: 1920×1080, 30 fps, 240 frames / 8 seconds, H.264/yuv420p,
  fast-start, no audio.
- `polaris-rover.jpg`: side-logo shot, used as the static fallback (the film opens
  from black, so the first frame is unsuitable as a poster).
- `polaris-rover.blend`: editable, compressed scene with the supplied script
  embedded and all movement baked. Kept in Git, excluded from the installer.
- `manifest.json`: dimensions, timing, poster frame, sizes and SHA-256 hashes.

See `scripts/blender/README.md` for reproducible rendering, encoding and checks.
The source is `scripts/blender/piora_intro.py`. The installer ships only MP4/JPG;
neither Blender nor Python is needed to play the startup film.

The desktop shows the complete frame without cropping or large overlaid titles,
offers Skip intro, honors reduced-motion preferences, and continues after the
film ends. A ten-second outer timeout prevents media initialization failures from
blocking startup. Later launches of the same version enter the workspace as soon
as it is ready.
