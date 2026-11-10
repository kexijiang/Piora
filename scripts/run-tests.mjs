import { spawn } from "node:child_process";
import { discoverTestFiles, partitionTests, readTestTimings } from "./test-suite-files.mjs";

const options = process.argv.slice(2);
const shardOptions = options.filter(option => option.startsWith("--test-shard="));
if (shardOptions.length > 1) throw new Error("Specify exactly one test shard");
let files = discoverTestFiles();
if (shardOptions.length) {
  const match = /^--test-shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shardOptions[0]);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error("Invalid test shard");
  const shard = Number(match[1]), count = Number(match[2]);
  const resourceOverhead = process.platform === "win32" && files.includes("lib/shell-runtime.test.mjs") ? 60_000 : 0;
  const bins = partitionTests(files, count, await readTestTimings(), resourceOverhead);
  files = bins[shard - 1].files;
  console.log(`Balanced shard ${shard}/${count}: ${files.length} files, estimated ${Math.round(bins[shard - 1].ms / 1000)}s including resource tests`);
}
// An empty partition must not cause Node to discover and rerun the whole suite.
if (!files.length) process.exit(0);

// Node only interprets test-runner options before the first file pattern.
// npm appends forwarded flags, so keep them ahead of the complete suite here.
const child = spawn(process.execPath, [
  "--test",
  "--test-concurrency=1",
  ...options.filter(option => !option.startsWith("--test-shard=")),
  ...files,
], { stdio: "inherit", windowsHide: true });

child.once("error", error => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
