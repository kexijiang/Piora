import { spawn } from "node:child_process";

// Node only interprets test-runner options before the first file pattern.
// npm appends forwarded flags, so keep them ahead of the complete suite here.
const child = spawn(process.execPath, [
  "--test",
  "--test-concurrency=1",
  ...process.argv.slice(2),
  "components/*.test.mjs",
  "hooks/*.test.mjs",
  "lib/*.test.mjs",
  "lib/i18n/*.test.mjs",
  "services/git-oauth/*.test.mjs",
  // Native lifecycle/transport helpers execute with the real host compiler;
  // keep these explicit so new device-source regressions are covered by CI.
  "scripts/harmony-native-encoder-lifecycle.test.mjs",
  "scripts/harmony-capture-background.test.mjs",
  "scripts/harmony-capture-session.test.mjs",
  "scripts/prepare-harmony-mirror.test.mjs",
  "scripts/harmony-mirror-provenance.test.mjs",
  "scripts/harmony-mirror-release.test.mjs",
  "scripts/verify-harmony-mirror-device.test.mjs",
], { stdio: "inherit", windowsHide: true });

child.once("error", error => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
