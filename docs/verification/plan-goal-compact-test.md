# Desktop test: plan-goal

Status: **passed**

Scope: real Electron UI, Next routes, SDK and workflow tools with a deterministic loopback model; API reads only verify results

- launch: passed (14620 ms)
- laboratory-default-off-and-enable: passed (653 ms)
- plan-new-chat-read-only: passed (7997 ms)
- plan-refresh-and-revise: passed (5843 ms)
- plan-approve-and-execute-once: passed (2205 ms)
- goal-existing-chat-budget: passed (3747 ms)
- goal-budget-edit-does-not-resume: passed (1808 ms)
- goal-pause-refresh-resume: passed (6224 ms)
- goal-cancel: passed (3276 ms)
- goal-process-restart-does-not-replay: passed (24672 ms)
- laboratory-disable-preserves-history-and-stop: passed (8035 ms)
- laboratory-disable-stops-next-turn: passed (5059 ms)

Cleanup errors: 0
Lock retained: false

Coverage: laboratory defaults off and is enabled through Settings UI; new-chat Plan selection; single-row Plan and Goal previews expand on hover without moving the composer or transcript; mode selector and collapsed/expanded screenshots; runtime denial of an attempted Plan write; immutable plan revision and confirmation; real SDK write after UI approval; Goal continuation and turn budget; pause, refresh, resume and cancel; process restart without automatic replay; persisted history and model-reported evidence; disabled laboratory preserves history and stop controls but blocks new modes and continuation; disabling laboratory stops automatic continuation at the current turn boundary

Not covered: real model reasoning or evidence truthfulness; arbitrary external MCP tools; packaged installer; non-Windows platforms; real task semantic acceptance
