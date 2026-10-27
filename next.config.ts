import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import { developmentFilesystemCache } from "./scripts/development-filesystem-cache.mjs";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
const deploymentId = `piora-${version.replace(/[^A-Za-z0-9_-]/g, "-")}`;
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow isolated dev benchmarks without replacing the interactive cache.
  distDir: process.env.NODE_ENV === "development" ? process.env.PIORA_DEV_DIST_DIR || ".next" : ".next",
  typescript: {
    tsconfigPath: process.env.NODE_ENV === "development" ? process.env.PIORA_DEV_TSCONFIG || "tsconfig.json" : "tsconfig.json",
  },
  // Proxy clones request bodies before the route reads them. Its 10 MiB
  // default truncates supported file uploads; leave room for multipart headers.
  experimental: {
    turbopackFileSystemCacheForDev: developmentFilesystemCache(),
    proxyClientMaxBodySize: 101 * 1024 * 1024,
    turbopackLazyDynamicImports: true,
    turbopackLazyDynamicImportsSSR: true,
  },
  turbopack: {
    root: __dirname,
    rules: Object.fromEntries(["clipboard-archive.ts", "clipboard-database.ts", "clipboard-types.ts"].map((file) => [file, {
      loaders: ["./scripts/desktop-dev-loader.cjs"],
      as: "*.mjs",
    }])),
    // Node16 desktop sources use emitted .js specifiers; resolve the two
    // clipboard modules shared with the server to their source during dev.
    resolveAlias: {
      "./clipboard-database.js": "./desktop/src/clipboard-database.ts",
      "./clipboard-types.js": "./desktop/src/clipboard-types.ts",
    },
  },
  // The app has a dedicated transparent desktop-pet renderer. Next's floating
  // development badge otherwise appears as an unexplained black disc inside
  // that frameless window; compiler and runtime errors remain enabled.
  devIndicators: false,
  // Electron keeps one persistent renderer partition across upgrades. Attach
  // the release identity to every client asset request so an older HTTP cache
  // entry can never be combined with the current Next.js runtime graph.
  // Next also uses this value to force a hard navigation if it detects skew.
  deploymentId,
  // Keep webpack/nft tracing inside the repository on Windows. Without an
  // explicit root, monorepo/workspace detection can broaden the standalone
  // trace and make the packaged output less deterministic.
  outputFileTracingRoot: __dirname,
  // The Harmony checker launches the pinned DevEco CLI as an owned child
  // process. Its executable and resource archives are runtime data rather
  // than modules imported into a Next route, so include the package explicitly.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@deveco/deveco-cli/**/*",
      "./node_modules/@deveco/deveco-cli-common/**/*",
      "./node_modules/@deveco/deveco-cli-knowledgebase/**/*",
      "./.harmony-worker/**/*",
      "./lib/harmony/runtime/deveco-password.mjs",
    ],
  },
  // Browser profiles contain user-owned cookies, storage and cache files. They
  // are runtime data, never application dependencies. Excluding them also
  // prevents node-file-trace from following a developer's local profile when
  // the persistent browser extension is compiled for standalone packaging.
  outputFileTracingExcludes: {
    "/*": [
      "**/.pi/agent/piora/browser-profile/**",
      "**/piora/browser-profile/**",
      "**/.git/**",
      "**/.next/dev/**",
      "**/.next/dev-stale-*/**",
      "**/desktop/release/**",
    ],
  },
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "@deveco/deveco-cli",
    "node-pty",
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    // Share transport/error class identities with the external native SDK.
    "@earendil-works/pi-mcp",
    "playwright-core",
    "proper-lockfile",
    "hypium-driver",
    "@grpc/grpc-js",
    "mediabunny",
    "ssh2",
  ],
  webpack(config, { isServer, dev }) {
    // Shared desktop TypeScript uses Node16 .js import specifiers.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".js", ".ts", ".tsx"] };
    // Release builds are one-shot and never reuse this cache. Disabling the
    // multi-hundred-megabyte filesystem cache also avoids a Webpack cache
    // finalization stall observed on Windows packaging machines.
    if (!dev) config.cache = false;
    // The instrumentation entry is compiled through a separate webpack path
    // that does not apply serverExternalPackages consistently. Keep undici as
    // a Node runtime dependency there as well; bundling it pulls in node:console
    // from its mock tooling and breaks the dev compiler.
    if (isServer && Array.isArray(config.externals)) {
      config.externals.push(
        "node-pty",
        /^node:/,
        "undici",
        "proper-lockfile",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-tui",
        "@earendil-works/pi-mcp",
        "@deveco/deveco-cli",
        "playwright-core",
        "hypium-driver",
        "@grpc/grpc-js",
    "mediabunny",
        "ssh2",
      );
    }
    return config;
  },
  // Dev-only: allow remote testing via localtunnel/Cloudflare-style public
  // hosts without a hard-coded tunnel name. `*.loca.lt` is the localtunnel
  // public suffix; LAN IPs keep on-network testing working. Never affects
  // production (dev servers only).
  allowedDevOrigins: ['192.168.*.*', '*.loca.lt'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
