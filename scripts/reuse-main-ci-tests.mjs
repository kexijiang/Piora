import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const allShards = ["windows-latest"].flatMap(os =>
  [1, 2, 3, 4, 5, 6].map(shard => ({ os, shard })));
const jobName = ({ os, shard }) => `tests / Tests (${os}, shard ${shard}/6)`;
const fullPlan = () => ({ mode: "full", pending: allShards, reused: [] });

export function selectMainPushRun(runs, sha) {
  return runs.find(run => run.head_sha === sha && run.head_branch === "main"
    && run.event === "push" && run.path === ".github/workflows/ci.yml") ?? null;
}

export function inspectTestJobs(run, jobs) {
  const selected = allShards.map(shard => jobs.filter(job => job.name === jobName(shard)));
  if (selected.some(matches => matches.length > 1)) return { ...fullPlan(), waiting: false };
  if (jobs.some(job => job.head_sha !== run.head_sha || job.run_id !== run.id)) return { ...fullPlan(), waiting: false };
  const reused = allShards.filter((_, i) => selected[i][0]?.status === "completed" && selected[i][0].conclusion === "success");
  const pending = allShards.filter(shard => !reused.includes(shard));
  const waiting = run.status !== "completed" && selected.some(matches => !matches[0] || matches[0].status !== "completed");
  return { mode: pending.length === 0 ? "reuse" : reused.length ? "partial" : "full", pending, reused, waiting };
}

export async function findReusableTests({ sha, getRuns, getJobs, now = Date.now,
  delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
  maxWaitMs = 25 * 60_000, missingRunWaitMs = 60_000, pollMs = 20_000 }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return fullPlan();
  const started = now();
  let latest = fullPlan();
  while (now() - started < maxWaitMs) {
    try {
      const run = selectMainPushRun(await getRuns(), sha);
      if (run) {
        const { waiting, ...plan } = inspectTestJobs(run, await getJobs(run.id));
        latest = plan;
        if (!waiting) return plan;
      } else if (now() - started >= missingRunWaitMs) return fullPlan();
    } catch (error) {
      console.warn(`Unable to inspect main CI; running the full fallback suite: ${error.message}`);
      return fullPlan();
    }
    await delay(pollMs);
  }
  return latest;
}

// Fail closed: every platform/shard must appear exactly once, either proven
// successful on main at this SHA or scheduled in the tag's fallback matrix.
export function verifyTestPlan(plan, lookupResult, testResult) {
  if (lookupResult !== "success" || !plan || !Array.isArray(plan.pending) || !Array.isArray(plan.reused)) return false;
  const keys = [...plan.pending, ...plan.reused].map(jobName).sort();
  if (JSON.stringify(keys) !== JSON.stringify(allShards.map(jobName).sort())) return false;
  return plan.pending.length ? testResult === "success" : testResult === "skipped";
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: token, GITHUB_OUTPUT: output } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !token || !output) throw new Error("Missing GitHub CI lookup context");
  const api = async path => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    return response.json();
  };
  const result = await findReusableTests({ sha,
    getRuns: async () => (await api(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`)).workflow_runs,
    getJobs: async id => (await api(`actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs,
  });
  await appendFile(output, `reuse=${result.mode === "reuse"}\nmatrix=${JSON.stringify({ include: result.pending })}\nplan=${JSON.stringify(result)}\n`);
  const summary = `Exact commit ${sha}: reuse ${result.reused.length}/12 successful shards; run ${result.pending.length}/12 remaining shards.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${result.pending.map(shard => `- Run ${jobName(shard)}`).join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
