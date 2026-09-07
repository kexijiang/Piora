import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
const deploymentId = `piora-${version.replace(/[^A-Za-z0-9_-]/g, "-")}`;
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  output: "standalone",
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
    "node-pty",
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "playwright-core",
    "proper-lockfile",
    "hypium-driver",
  ],
  webpack(config, { isServer, dev }) {
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
        "playwright-core",
        "hypium-driver",
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
