import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("committed startup media has a valid container, exact manifest hashes and a bounded installer payload", async () => {
  const root = new URL("../desktop/build/startup/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.frames / manifest.fps, 8);
  assert.equal(manifest.audio, false);
  let shipped = 0;
  for (const [name, entry] of Object.entries(manifest.files)) {
    assert.match(name, /^polaris-rover\.(mp4|jpg|blend)$/);
    const bytes = await readFile(new URL(name, root));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    if (name.endsWith("mp4")) {
      assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
      assert.ok(bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")), "fast-start metadata must precede the video frames");
      assert.ok(bytes.length > 100_000 && bytes.length <= 12_000_000);
      shipped += bytes.length;
    } else if (name.endsWith("jpg")) {
      assert.equal(bytes.readUInt16BE(0), 0xffd8);
      assert.ok(bytes.length <= 1_000_000);
      shipped += bytes.length;
    }
  }
  assert.ok(shipped <= 13_000_000);
  const builder = await readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /from: build\/startup\s+to: startup\s+filter:\s+- "\*\.mp4"\s+- "\*\.jpg"/);
});
