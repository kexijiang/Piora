import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const testPatterns = [
  "components/*.test.mjs", "hooks/*.test.mjs", "lib/*.test.mjs", "lib/i18n/*.test.mjs",
  "services/git-oauth/*.test.mjs",
  "scripts/harmony-native-encoder-lifecycle.test.mjs", "scripts/harmony-capture-background.test.mjs",
  "scripts/harmony-capture-session.test.mjs", "scripts/prepare-harmony-mirror.test.mjs",
  "scripts/harmony-mirror-provenance.test.mjs", "scripts/harmony-mirror-release.test.mjs",
  "scripts/verify-harmony-mirror-device.test.mjs",
];

export function discoverTestFiles(root = process.cwd()) {
  return [...new Set(testPatterns.flatMap(pattern => [...globSync(pattern, { cwd: root })]))]
    .map(file => file.replaceAll("\\", "/")).sort();
}

export function partitionTests(files, count, timings = {}, resourceOverheadMs = 60_000) {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid test shard count");
  const bins = Array.from({ length: count }, (_, index) => ({ files: [], ms: index === 0 ? resourceOverheadMs : 0 }));
  const weight = file => Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : 500;
  // Longest first, deterministic tie breaks; include shard 1's existing Shell tests.
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"))) {
    const target = bins.reduce((best, bin) => bin.ms < best.ms ? bin : best);
    target.files.push(file); target.ms += weight(file);
  }
  return bins.map(bin => ({ ...bin, files: bin.files.sort() }));
}

export async function readTestTimings() {
  return JSON.parse(await readFile(new URL("./test-shard-timings.json", import.meta.url), "utf8")).files;
}
