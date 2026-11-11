import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, parse } from "node:path";
import test from "node:test";
import { assertVerificationDirectory, verificationTempRoot } from "../scripts/verification-temp.mjs";

test("CI verification uses the runner scratch disk while local runs keep the OS temporary root", () => {
  const base = resolve(tmpdir());
  const runner = join(base, "runner-scratch"), repo = join(base, "checkout");
  assert.equal(verificationTempRoot({ CI: "true", RUNNER_TEMP: runner }, base, repo), runner);
  assert.equal(verificationTempRoot({ RUNNER_TEMP: runner }, base, repo), base);
  assert.equal(verificationTempRoot({ CI: "true" }, base, repo), base);
  assert.throws(() => verificationTempRoot({ CI: "true", RUNNER_TEMP: "relative" }, base, repo), /absolute/);
  for (const invalid of [repo, join(repo, "temporary"), base, parse(base).root]) {
    assert.throws(() => verificationTempRoot({ CI: "true", RUNNER_TEMP: invalid }, base, repo), /isolated/);
  }
  assert.equal(assertVerificationDirectory(join(runner, "piora-fixture"), [runner]), join(runner, "piora-fixture"));
  for (const invalid of [runner, repo, join(runner, "..", "outside")]) {
    assert.throws(() => assertVerificationDirectory(invalid, [runner]), /Unsafe/);
  }
});
