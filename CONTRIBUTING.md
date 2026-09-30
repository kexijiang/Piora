# Contributing to Piora

Thank you for helping build Piora. The repository uses **Piora** as the name of its initial public preview. The project is evolving from the `agegr/pi-web` codebase toward a Windows desktop application powered by the `earendil-works/pi` agent. A future rename must update package metadata, application identity, documentation, and repository links together.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are made under the repository's MIT License.

## Before opening an issue

- Search existing issues and pull requests first.
- Use a bug report for reproducible defects and a feature request for product proposals.
- Do not publish vulnerabilities, credentials, private prompts, session files, or sensitive logs. Follow [SECURITY.md](SECURITY.md) instead.
- Keep feature requests focused on Piora. Upstream pi-web or Pi defects may need a minimal reproduction before we can decide where they belong.

## Development setup

Requirements:

- Node.js 22.19.0 or newer
- npm (the committed `package-lock.json` is the canonical npm lockfile)
- Git
- On Windows, a Bash implementation supported by Pi when exercising agent tools (for example, Git Bash)

From PowerShell:

```powershell
npm ci
npm run dev
```

The development server listens on `127.0.0.1:30141`.

Do not run `next build` or `npm run build` during development. It can pollute `.next/` and break the active development server.

## Quality checks

Run all checks before submitting a pull request:

```powershell
npm run licenses:check
npm run audit:runtime
npm run verify:hygiene
npm run lint
npm run typecheck
npm test
npm run verify:backgrounds
```

CI is configured to run the source checks on Windows and Linux, including deterministic license-inventory freshness, then build and verify the unpacked application on Windows. Release changes should additionally complete the artifact, extension-fixture, license, secret, and clean-machine checks in the [public launch checklist](docs/open-source/LAUNCH_CHECKLIST.md). A workflow configuration is not evidence that a public run has passed.

`audit:runtime` verifies that Pi's two reviewed postinstall dependency replacements
have the expected locked identities and exactly match the installed source files,
then asks npm to audit a temporary lock describing those final versions. The
committed lock remains unchanged and no advisory is suppressed. The independent
`website` lock is checked separately in CI with normal peer resolution, an audit,
`npm run check`, and a Sites build.

## Making a change

1. Create a focused branch from the current default branch.
2. Keep changes small and avoid unrelated formatting churn.
3. Add or update tests when the affected area has test coverage.
4. Preserve Pi session compatibility and the security boundaries described in `AGENTS.md`.
5. Update user-facing documentation when behavior changes.
6. Run the quality checks and complete the pull request template.

For changes inherited from an upstream project, link the corresponding upstream issue or commit when possible. Do not remove upstream copyright or license notices.

## Pull requests

A pull request should explain:

- the problem and intended behavior;
- the approach and important tradeoffs;
- how it was verified, including the Windows version when relevant;
- security or privacy effects;
- screenshots or recordings for visible UI changes.

Maintainers may ask for a change to be split if it mixes product work, refactoring, and dependency updates. Review approval does not transfer copyright; each contributor retains copyright in their contribution while licensing it under MIT.

## Architecture-sensitive areas

Please read `AGENTS.md` before editing agent lifecycle, session branching, streaming/reconciliation, file access, worktrees, authentication, plugins, or skills. These areas have invariants that are easy to break with a locally plausible change.

## Communication

Be specific, patient, and assume good intent. Technical disagreement is welcome; personal attacks and harassment are not.
