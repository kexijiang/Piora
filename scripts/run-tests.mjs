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
], { stdio: "inherit", windowsHide: true });

child.once("error", error => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
