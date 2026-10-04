# Pi 1.0.2 duplicate compiled dependency remediation

## Official inputs and call path

The integrity-locked [official npm package](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.0.2.tgz) contains both complete unbundled `dist` output and a second esbuild distribution in `dist/bundle`. The [official builder](https://github.com/earendil-works/pi/blob/v1.0.2/scripts/build-coding-agent-bundle.mjs) takes the unbundled CLI, SDK and RPC entrypoints, inlines npm dependencies and defines `PI_BUNDLED_NODE=true`. Its [release lock](https://github.com/earendil-works/pi/blob/v1.0.2/package-lock.json) resolves Undici 8.10.2. No package-version literal or source map remains in the compiled chunk, so the lock is build provenance, not a runtime version readout.

`cli/setup` and `rpc-entry` configure `core/http-dispatcher`; `main` and interactive settings can reconfigure it. That module imports Undici and uses Client, Pool, EnvHttpProxyAgent, setGlobalDispatcher and install. Both CLI/RPC entrypoints reach the 110 Undici CommonJS wrappers in `chunk-ZSBPJAJ2.js`. The bundle index also shares this chunk. Merely overriding the separately installed package does not replace these wrappers.

An independent diagnostic compiled the integrity-verified official Undici 8.10.2 tarball using upstream's esbuild 0.28.2 and matching minifySyntax/minifyWhitespace, Node 22.19, ESM options. All **110/110 wrapper ASTs match** after excluding source locations/raw formatting, expanding shorthand-property syntax and normalizing numeric identifier collision suffixes. Literal values and operators are unchanged. Together with the official lock this identifies the embedded implementation as 8.10.2; the normalized comparison is diagnostic evidence and is never used to accept compiled bytes in the security guard.

The same official package exposes `dist/index.js` as its SDK root; its `build:unbundled` script creates `dist/cli.js` and `dist/rpc-entry.js` before bundling. Its unbundled RpcClient defaults to `dist/cli.js`. This is already the execution profile used by Piora's in-process SDK.

## Consumer-side source profile

The postinstall patch now verifies the exact official package.json, all **985 unbundled dist files**, and the original **74-file bundle tree** against SHA-256 commitments derived from the SHA-512 verified npm tarball. Unknown bytes/versions and links are rejected before modifying anything. The certificate is [committed](../../scripts/pi-source-profile-1.0.2.json), with [implementation](../../scripts/pi-source-profile.mjs).

Only the duplicate `dist/bundle` distribution is replaced with three exact tiny entrypoint shims. Public bin, RPC export and bundle index paths continue to exist, forwarding to the official unbundled CLI, RPC and SDK files. The package manifest, version and 985 original unbundled files remain byte-for-byte unchanged. No dependency code is transplanted, no version relabeled, no unofficial rebuild supplied. This is a Piora consumer patch selecting upstream's own unbundled output, not a new upstream release or an upstream endorsement of this patch.

The effective Undici is resolved **from Pi's package**, and must be 8.11.2. Existing replacement byte/version guards remain. The embedded-code scan still rejects every embedded Undici wrapper, and packaging/runtime audit additionally require the exact source profile: an empty scan alone is insufficient. A second install/staging check accepts only the exact post-state, not arbitrary externalized code.

Unbundled config retains upstream's normal QuickJS WASM and pi-codemode worker resolution; provider/auth lazy files stay in their complete packages. Complete production dependency closures are staged, preserving CLI, RPC, SDK, OAuth, image workers, MCP and codemode dependencies. The source profile performs no network requests or credential edits.

## Validation and remaining blockers

Clean npm ci applies the transformation to the original integrity-locked package. Local regression verifies isolated production closure, public CLI/RPC version output, identical SDK exports, QuickJS WASM/worker resolution, effective Undici 8.11.2, idempotence, and rejection of altered source, launchers, links and extra embedded modules. These checks do not claim a real provider request or a Windows application build.

Runtime audit now has zero embedded dependency findings, but still fails on node-forge/DevEco. Official npm still lists node-forge 1.4.0 and braces 3.0.3; the known advisories have no officially released fix. No node-forge experiment is retried. Website/full audit, real model acceptance, Windows packaged isolation and required exact-head CI remain independent gates. PR142 stays draft until all required gates actually pass.
