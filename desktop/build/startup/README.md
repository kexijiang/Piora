# Polaris Expedition

Original Piora artwork, licensed under the repository MIT license. The rover,
terrain, sky, camera movement, materials and lights were authored procedurally in
Blender; no downloaded models or textures are used. This is a stylized fictional
polar world inspired by the user's “rover on Polaris” concept.

- `polaris-rover.mp4`: 1280×720, 24 fps, 8 seconds, H.264/yuv420p, no audio.
- `polaris-rover.jpg`: first-frame poster and reduced-motion fallback.
- `polaris-rover.blend`: editable Blender scene. Kept in Git but excluded from the installer.
- `manifest.json`: asset sizes and SHA-256 hashes, checked by source tests.

Rebuild using Blender 5.2.1 LTS and FFmpeg 7.1 (or compatible releases):

```powershell
blender -b -t 6 --python scripts/blender/polaris-rover.py -- --output .verification/polaris
node scripts/encode-startup-video.mjs <path-to-ffmpeg> .verification/polaris
```

Use `--preview` after the Blender script arguments for a single composition
preview. `--start N --end N` can rerender a frame range. Source scene rendering
requires Blender; playback in Piora does not. The installer ships only MP4/JPG.

The desktop startup screen has no network dependencies, offers Skip intro,
pauses video for reduced-motion preferences and has an eight-second bounded
intro on the first launch of a version. Later launches enter the workspace as
soon as it is ready. A missing/unplayable video falls back to the poster/gradient.
