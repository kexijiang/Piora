import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { assembleBrandRelease, brandReleaseGroups } from "../scripts/assemble-brand-release.mjs";

async function fixture(t, tag = "v1.2.3-beta.4") {
  const root = await mkdtemp(resolve(tmpdir(), "piora-release-assembly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = resolve(root, "canonical-notes.md");
  await writeFile(notes, "测试更新说明\n");
  const groups = brandReleaseGroups(tag);
  for (const group of groups) {
    const directory = resolve(root, group.directory);
    await mkdir(directory);
    const checksums = [];
    for (const name of group.files) {
      const bytes = Buffer.from(name);
      await writeFile(resolve(directory, name), bytes);
      checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
    await writeFile(resolve(directory, group.checksum), checksums.join("\n") + "\n");
    await writeFile(resolve(directory, "release-notes.md"), await readFile(notes));
  }
  const output = resolve(root, "assembled");
  return { root, output, notes, groups, run: () => assembleBrandRelease(root, output, tag, notes) };
}

for (const tag of ["v1.2.3-beta.4", "v1.2.3"]) {
  test(`assembles Piora platform artifacts without overwriting checksums: ${tag}`, async t => {
    const f = await fixture(t, tag);
    const result = await f.run();
    assert.equal(result.length, tag.includes("beta") ? 4 : 6);
    assert.equal((await readdir(f.output)).length, result.length + 2);
    assert.equal((await readFile(resolve(f.output, "SHA256SUMS.txt"), "utf8")).trim().split("\n").length, result.length);
    await assert.rejects(f.run(), { code: "EEXIST" });
  });
}

test("assembly rejects missing artifact group, corrupted bytes, foreign files and inconsistent notes before output", async t => {
  for (const kind of ["missing-group", "corrupt", "extra-file", "notes", "duplicate-checksum"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const group = f.groups[0];
      const directory = resolve(f.root, group.directory);
      if (kind === "missing-group") await rm(directory, { recursive: true });
      if (kind === "corrupt") await writeFile(resolve(directory, group.files[0]), "changed");
      if (kind === "extra-file") await writeFile(resolve(directory, "latest.yml"), "wrong brand");
      if (kind === "notes") await writeFile(resolve(directory, "release-notes.md"), "wrong version");
      if (kind === "duplicate-checksum") {
        const path = resolve(directory, group.checksum);
        const text = await readFile(path, "utf8");
        await writeFile(path, text + text);
      }
      await assert.rejects(f.run());
      await assert.rejects(readdir(f.output), { code: "ENOENT" });
    });
  }
});
