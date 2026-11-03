import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { brandReleaseGroups } from "../scripts/assemble-brand-release.mjs";

for (const [buildFile, publishFile, tag, builders, publisher, dependencies] of [
  ["release.yml", "release.yml", "v1.2.3", ["windows-build"], "publish-release", ["tests", "windows-build"]],
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
    assert.equal(workflow.jobs["linux-build"], undefined);
    for (const builder of builders) {
      const steps = workflow.jobs[builder].steps;
      const upload = steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
      assert.doesNotMatch(upload.with.path, /portable\.exe|\.zip|AppImage/);
      const checksums = steps.find(step => step.name === "Generate checksums");
      assert.doesNotMatch(checksums.run, /portable\.exe|\.zip|AppImage/);
    }
    if (dependencies) assert.deepEqual([...publish.needs].sort(), dependencies.sort());
    else {
      assert.equal(workflow.jobs[publisher], undefined);
      assert.ok(publicationWorkflow.on.workflow_dispatch);
      assert.equal(publish.environment, undefined);
      assert.deepEqual(publicationWorkflow.on.workflow_run, {
        workflows: [workflow.name], types: ["completed"],
      });
      assert.match(publish.if, /workflow_run\.conclusion == 'success'/);
      assert.match(publish.if, /workflow_run\.event == 'push'/);
      assert.match(publish.if, /workflow_run\.head_repository\.full_name == github\.repository/);
      assert.match(publish.if, /contains\(github\.event\.workflow_run\.head_branch, '-beta\.'\)/);
      assert.equal(publish.env.PREVIEW_TAG, "${{ inputs.tag || github.event.workflow_run.head_branch }}");
      assert.equal(publish.env.BUILD_RUN_ID, "${{ inputs.build_run_id || github.event.workflow_run.id }}");
      assert.equal(publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@")).with["run-id"], "${{ env.BUILD_RUN_ID }}");
      const sourceGate = publish.steps.find(step => step.run?.includes("verify-release-metadata.mjs"));
      assert.match(sourceGate.run, /run\.conclusion -ne 'success'/);
      assert.match(sourceGate.run, /run\.head_sha -ne \$tagCommit/);
      assert.match(sourceGate.run, /run\.path -ne '\.github\/workflows\/harmony-preview\.yml'/);
      assert.match(sourceGate.run, /Release metadata verification failed/);
    }
    const download = publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(download.with["merge-multiple"], false);
    const assembleIndex = publish.steps.findIndex(step => step.run?.includes("assemble-brand-release.mjs"));
    const releaseIndex = publish.steps.findIndex(step => step.run?.includes("gh release create"));
    assert.ok(assembleIndex >= 0 && releaseIndex > assembleIndex);
    assert.match(publish.steps[assembleIndex].run, /LASTEXITCODE/);
    const command = publish.steps[releaseIndex].run;
    assert.doesNotMatch(command, /portable\.exe|\.zip|AppImage/);
    assert.match(command, /--verify-tag/);
    assert.match(command, /--notes-file/);
    for (const group of brandReleaseGroups(tag)) {
      for (const name of group.files) assert.ok(command.includes(name.replace(tag.slice(1), "$version")), `Missing published asset: ${name}`);
    }
  });
}
