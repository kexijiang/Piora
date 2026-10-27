# vscode-jsonrpc 10 compatibility review

The manifest and lockfile pin `10.0.0`; the official npm artifact URL retains the existing integrity hash. The production `lib/code-intelligence.ts` import remains `vscode-jsonrpc/node`, the Node entry point documented in the [upstream README](https://github.com/microsoft/vscode-languageserver-node/blob/main/jsonrpc/README.md).

`lib/code-intelligence-jsonrpc.test.mjs` executes the production code-intelligence module against the installed package with two real `PassThrough` streams. Only DevEco process launch and environment discovery are substituted. Both peers use real JSON-RPC framing and dispatch, including a server-to-client configuration request while initialization is pending, initialized/didOpen/didChange/didClose notifications and hover responses.

Initialization and hover error/timeout cases verify basic-mode fallback, connection disposal, child termination, request timer cleanup and final session removal. Timeout tests trigger the actual production timer after the peer receives the request; they do not shorten timeouts in production. Existing code-intelligence tests retain TypeScript and basic ArkTS behavior coverage. Device-specific DevEco integration still needs its real SDK/hardware environment.
