import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";
import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { answerOutputExportAppendix } from "@/lib/answer-output-server";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

type PiCodingAgentModule = {
  getPackageDir: () => string;
};

type ExportHtmlModule = {
  exportFromFile: (inputPath: string, outputPath: string) => Promise<string>;
};

async function getPiPackageDir(): Promise<string | null> {
  try {
    const { getPackageDir } = (await import("@earendil-works/pi-coding-agent")) as PiCodingAgentModule;
    return getPackageDir();
  } catch {
    return null;
  }
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

async function getPiCliPath(): Promise<string | null> {
  const candidates = new Set<string>();
  const packageDir = await getPiPackageDir();

  if (packageDir) {
    candidates.add(join(packageDir, "dist", "cli.js"));
  }

  try {
    const resolver = (import.meta as ImportMeta & {
      resolve?: (specifier: string) => string | Promise<string>;
    }).resolve;
    if (typeof resolver === "function") {
      const indexUrl = await resolver("@earendil-works/pi-coding-agent");
      candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
    }
  } catch {
    // Next.js production bundles can strip import.meta.resolve.
  }

  candidates.add(
    join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js"
    )
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Patch the exported HTML to fix recursive functions that overflow
 * the call stack on deep linear session trees (e.g., 5000+ entries).
 *
 * ## Root Cause
 * pi-coding-agent's template.js uses recursive helpers to render and
 * navigate the session tree in the exported HTML:
 *
 *   1. sortChildren(node) — recursively sorts children of every node.
 *      Calls itself via node.children.forEach(sortChildren).
 *      On a 5527-entry linear chain (no branches), this recurses 5527
 *      levels deep → stack overflow.
 *
 *   2. mapNodes(node) — recursively indexes tree nodes the first time
 *      a tree item is clicked. Same depth -> same overflow.
 *
 *   3. markActive(node) — recursively marks nodes on the active path.
 *      Calls itself via markActive(child) for each child.
 *      Same depth → same overflow.
 *
 * Both functions are inlined in the HTML by pi-coding-agent at export
 * time. We cannot modify template.js directly (it's in node_modules
 * and would be overwritten on npm install). Instead, we patch the
 * generated HTML string before returning it to the client.
 *
 * ## Fix
 * Replace each recursive function with an iterative equivalent:
 *
 *   sortChildren  → explicit stack (DFS pre-order, push children in
 *                   reverse to maintain order)
 *   mapNodes      → explicit stack (DFS pre-order)
 *   markActive    → two-stack post-order (stack1 for traversal,
 *                   stack2 for processing children before parent)
 *
 * ## Line Ending Normalization
 * This file (route.ts) uses CRLF (Windows), while template.js uses LF
 * (Unix). The template strings in the backtick literals inherit the
 * file's CRLF line endings. At runtime, readFileSync() also returns
 * CRLF on Windows. We normalize everything to LF before matching.
 *
 * The helper `n(s)` strips \r\n → \n on both the HTML and the
 * replacement strings, ensuring cross-platform matching.
 */
function patchExportHtml(html: string): string {
  // Normalize line endings: route.ts is CRLF, template.js is LF.
  // Without this, the replace() below would fail on Windows.
  const n = (s: string) => s.replace(/\r\n/g, "\n");
  html = n(html);

  const replaceRequired = (source: string, name: string, search: string, replacement: string) => {
    const normalizedSearch = n(search);
    const normalizedReplacement = n(replacement);
    const matches = source.split(normalizedSearch).length - 1;
    if (matches !== 1) {
      throw new Error(`Failed to patch exported HTML: ${name} expected 1 match, found ${matches}`);
    }
    return source.replace(normalizedSearch, normalizedReplacement);
  };

  html = replaceRequired(
    html,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`
  );

  html = replaceRequired(
    html,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`
  );

  html = replaceRequired(
    html,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          // Post-order traversal using two stacks
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`
  );

  return html;
}

function injectBeforeClosingTag(html: string, closingTag: "</head>" | "</body>", content: string): string {
  const index = html.toLowerCase().lastIndexOf(closingTag);
  if (index < 0) return `${html}${content}`;
  return `${html.slice(0, index)}${content}${html.slice(index)}`;
}

function patchEmbeddedExportHtml(html: string, appearance: "light" | "dark"): string {
  const lightPalette = appearance === "light" ? `
  <style data-pi-history-appearance>
    :root {
      color-scheme: light;
      --accent: #3973c8;
      --border: #d8d7d3;
      --borderAccent: #9bb7df;
      --borderMuted: #e6e5e1;
      --success: #267a48;
      --error: #be3f38;
      --warning: #9a640d;
      --muted: #73736f;
      --dim: #989892;
      --text: #2f2f2c;
      --thinkingText: #74746f;
      --selectedBg: #e8edf6;
      --userMessageBg: #f1f0ed;
      --userMessageText: #2f2f2c;
      --customMessageBg: #f3eef7;
      --customMessageText: #3c3541;
      --customMessageLabel: #76529d;
      --toolPendingBg: #f4f3f0;
      --toolSuccessBg: #edf6ef;
      --toolErrorBg: #fff0ef;
      --toolTitle: #343431;
      --toolOutput: #6d6d68;
      --mdHeading: #875d17;
      --mdLink: #3569ad;
      --mdLinkUrl: #85857f;
      --mdCode: #176c66;
      --mdCodeBlock: #356f4a;
      --mdCodeBlockBorder: #d2d1cc;
      --mdQuote: #74746f;
      --mdQuoteBorder: #cecdc8;
      --mdHr: #d9d8d3;
      --mdListBullet: #4e719d;
      --toolDiffAdded: #247447;
      --toolDiffRemoved: #b13d35;
      --toolDiffContext: #777772;
      --syntaxComment: #5f7d55;
      --syntaxKeyword: #365f9d;
      --syntaxFunction: #7b641b;
      --syntaxVariable: #1f6f82;
      --syntaxString: #9a4b34;
      --syntaxNumber: #5d7338;
      --syntaxType: #167169;
      --syntaxOperator: #3c3c39;
      --syntaxPunctuation: #4b4b47;
      --thinkingOff: #a2a29c;
      --thinkingMinimal: #8b8b85;
      --thinkingLow: #6683a5;
      --thinkingMedium: #4f719a;
      --thinkingHigh: #7d6593;
      --thinkingXhigh: #955ba5;
      --thinkingMax: #a63e9c;
      --bashMode: #527238;
      --exportPageBg: #f4f3f0;
      --exportCardBg: #ffffff;
      --exportInfoBg: #fff7df;
      --body-bg: #f4f3f0;
      --container-bg: #ffffff;
      --info-bg: #fff7df;
    }
  </style>` : `
  <style data-pi-history-appearance>:root { color-scheme: dark; }</style>`;

  const embeddedChrome = `
  <style data-pi-history-embed>
    :root {
      --line-height: 20px;
      --sidebar-width: min(300px, 30vw);
      --sidebar-min-width: 220px;
      --sidebar-max-width: 460px;
    }
    html, body, #app { height: 100%; min-height: 100%; }
    body {
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.55;
    }
    button, input { font-family: inherit; }
    code, pre, .tree-container, .tree-status, .tool-command, .tool-output, .message-timestamp {
      font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace;
    }
    #sidebar {
      border-right-color: var(--borderMuted);
      box-shadow: inset -1px 0 color-mix(in srgb, var(--borderMuted) 42%, transparent);
    }
    .sidebar-header {
      padding: 12px 10px 10px;
      border-bottom: 1px solid var(--borderMuted);
      background: color-mix(in srgb, var(--container-bg) 92%, var(--body-bg));
    }
    .sidebar-search {
      min-height: 32px;
      padding: 5px 9px;
      border-color: var(--borderMuted);
      border-radius: 8px;
      background: var(--body-bg);
      font-size: 12px;
      outline: none;
    }
    .sidebar-search:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .sidebar-filters {
      gap: 4px;
      padding: 8px 0 0;
    }
    .filter-btn {
      min-height: 25px;
      padding: 3px 8px;
      border-color: var(--borderMuted);
      border-radius: 6px;
      font-size: 10px;
    }
    .filter-btn:hover { background: var(--selectedBg); color: var(--text); }
    .filter-btn.active {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    .tree-container {
      padding: 7px 4px;
      font-size: 11px;
      line-height: 1.5;
    }
    .tree-status {
      border-top: 1px solid var(--borderMuted);
      background: color-mix(in srgb, var(--container-bg) 92%, var(--body-bg));
    }
    #sidebar-resizer { width: 5px; }
    #content {
      align-items: center;
      padding: 20px clamp(18px, 3vw, 42px);
      scroll-behavior: smooth;
    }
    #header-container, #messages { width: min(820px, 100%); }
    .header {
      margin-bottom: 18px;
      padding: 16px 18px;
      border: 1px solid var(--borderMuted);
      border-radius: 12px;
      box-shadow: 0 1px 2px color-mix(in srgb, #000 6%, transparent);
    }
    .header-toggle-btn, .download-json-btn {
      min-height: 28px;
      padding: 3px 9px;
      border-color: var(--borderMuted);
      border-radius: 7px;
      background: var(--container-bg);
      color: var(--text);
    }
    .header-toggle-btn:hover, .download-json-btn:hover {
      border-color: var(--accent);
      background: var(--selectedBg);
    }
    #messages { gap: 18px; }
    .user-message {
      padding: 12px 14px;
      border: 1px solid color-mix(in srgb, var(--borderMuted) 76%, transparent);
      border-radius: 11px;
    }
    .assistant-message { line-height: 1.65; }
    .model-change, .branch-summary, .compaction, .thinking-block, .system-prompt,
    .tool-execution, .hook-message, .skill-invocation {
      border-radius: 9px !important;
    }
    .copy-link-btn {
      border-color: var(--borderMuted);
      border-radius: 7px;
    }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb {
      border: 3px solid transparent;
      border-radius: 999px;
      background: color-mix(in srgb, var(--muted) 48%, transparent);
      background-clip: padding-box;
    }
    ::-webkit-scrollbar-track { background: transparent; }
  </style>`;

  const escapeBridge = `
  <script data-pi-history-bridge>
    window.addEventListener("keydown", function (event) {
      if (event.key === "Escape") window.parent.postMessage("pi-session-history:escape", "*");
    });
  </script>`;

  return injectBeforeClosingTag(
    injectBeforeClosingTag(html, "</head>", `${lightPalette}${embeddedChrome}`),
    "</body>",
    escapeBridge,
  );
}

async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const cliPath = await getPiCliPath();
  if (cliPath) {
    await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  const packageDir = await getPiPackageDir();
  if (!packageDir) throw new Error("pi CLI not found");

  const exporterUrl = pathToFileURL(join(packageDir, "dist", "core", "export-html", "index.js")).href;
  const { exportFromFile } = (await import(exporterUrl)) as ExportHtmlModule;
  await exportFromFile(filePath, outputPath);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const searchParams = new URL(req.url).searchParams;
  const inline = searchParams.get("inline") === "1";
  const embed = inline && searchParams.get("embed") === "1";
  const appearance = searchParams.get("appearance") === "light" ? "light" : "dark";

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const tempDir = join(tmpdir(), "pi-web-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `pi-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      const appendix = await answerOutputExportAppendix(id, filePath).catch(() => "");
      const patchedHtml = patchExportHtml(html).replace("</body>", `${appendix}</body>`);
      const responseHtml = embed ? patchEmbeddedExportHtml(patchedHtml, appearance) : patchedHtml;
      return new Response(responseHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Cache-Control": "no-cache",
          "Content-Security-Policy": embed ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          ...(embed ? {} : { "X-Frame-Options": "DENY" }),
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
