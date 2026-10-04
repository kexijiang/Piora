import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { brandReleaseGroups } from "../scripts/assemble-brand-release.mjs";

for (const [buildFile, publishFile, tag, builders, publisher, dependencies] of [
  ["release.yml", "release.yml", "v1.2.3", ["windows-build", "linux-build"], "publish-release", ["tests", "windows-build", "linux-build"]],
  ["harmony-preview.yml", "publish-preview.yml", "v1.2.3-beta.4", ["windows-preview"], "publish-preview", null],
]) {
  test(`${buildFile} builds only Piora and publication consumes the verified artifact groups`, async () => {
    const workflow = load(await readFile(resolve(import.meta.dirname, "../.github/workflows", buildFile), "utf8"));
    const publicationWorkflow = publishFile === buildFile ? workflow
      : load(await readFile(resolve(import.meta.dirname, "../.github/workflows", publishFile), "utf8"));
    const artifacts = [];
    for (const builder of builders) {
      const job = workflow.jobs[builder];
      assert.deepEqual(job.strategy.matrix.include.map(item => item.brand), ["piora"]);
      assert.equal(job.env.PIORA_BRAND, "${{ matrix.brand }}");
      const sourceGate = job.steps.find(step => step.run?.includes("verify-release-metadata.mjs"));
      assert.match(sourceGate.run, /git fetch/);
      assert.match(sourceGate.run, /--require-origin-main/);
      const upload = job.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
      for (const row of job.strategy.matrix.include) {
        artifacts.push(upload.with.name.replace("${{ matrix.brand }}", row.brand).replace("${{ github.ref_name }}", tag));
        assert.equal(row.prefix, "Piora");
        if (builder.startsWith("windows")) {
          const channel = `${tag.includes("beta") ? "beta" : "latest"}`;
          assert.equal(row.channel, channel);
          assert.ok(upload.with.path.includes("${{ matrix.channel }}.yml"));
          assert.ok(job.steps.some(step => step.run?.includes("verify-windows-update-artifacts.mjs")));
        }
      }
    }
    assert.deepEqual(artifacts.sort(), brandReleaseGroups(tag).map(group => group.directory).sort());
    const publish = publicationWorkflow.jobs[publisher];
    if (dependencies) assert.deepEqual([...publish.needs].sort(), dependencies.sort());
    else {
      assert.equal(workflow.jobs[publisher], undefined);
      assert.ok(publicationWorkflow.on.workflow_dispatch);
      assert.equal(publish.environment, "preview-publish");
      assert.match(publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@")).with["run-id"], /inputs\.build_run_id/);
    }
    const download = publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(download.with["merge-multiple"], false);
    const assembleIndex = publish.steps.findIndex(step => step.run?.includes("assemble-brand-release.mjs"));
    const releaseIndex = publish.steps.findIndex(step => step.run?.includes("gh release create"));
    assert.ok(assembleIndex >= 0 && releaseIndex > assembleIndex);
    assert.match(publish.steps[assembleIndex].run, /LASTEXITCODE/);
    const command = publish.steps[releaseIndex].run;
    assert.match(command, /--verify-tag/);
    assert.match(command, /--notes-file/);
    for (const group of brandReleaseGroups(tag)) {
      for (const name of group.files) assert.ok(command.includes(name.replace(tag.slice(1), "$version")), `Missing published asset: ${name}`);
    }
  });
}
