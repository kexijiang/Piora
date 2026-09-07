import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { buildVirtualOffsets, virtualRange } from "../lib/virtual-window.ts";
import { indexTaskTree, flattenTaskWindow } from "../lib/sidebar-tree-window.ts";
const { buildChatHistoryRows } = await createJiti(import.meta.url).import("../lib/chat-history.ts");
import { getDiffRenderWindow, DIFF_RENDER_BATCH } from "../lib/diff-progressive.ts";
import { buildEntriesFromFiles, filterFileEntries } from "../lib/file-fuzzy.ts";
import { filterSessions } from "../lib/session-search.ts";
import { getReviewListWindow } from "../lib/review-progressive.ts";
import { getTreeRenderWindow, TREE_INITIAL_RENDER_COUNT } from "../lib/tree-progressive.ts";

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function measure(name, budgetMs, run) {
  run();
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  const elapsed = median(samples);
  const passed = elapsed <= budgetMs;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${elapsed.toFixed(2)}ms / ${budgetMs}ms`);
  return passed;
}

function verify(name, passed) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  return passed;
}

const sessions = Array.from({ length: 500 }, (_, index) => ({
  id: `session-${index}`,
  path: `C:/sessions/session-${index}.jsonl`,
  cwd: `C:/workspace/project-${index % 20}`,
  name: `Task ${index}`,
  created: new Date(Date.UTC(2026, 7, 9, 0, index)).toISOString(),
  modified: new Date(Date.UTC(2026, 7, 9, 0, index)).toISOString(),
  messageCount: 2,
  firstMessage: `Task ${index}`,
}));
const files = Array.from({ length: 5_000 }, (_, index) => `src/feature-${index % 100}/file-${index}.ts`);
const fileEntries = buildEntriesFromFiles(files);
const history = Array.from({ length: 10_000 }, (_, index) => index % 2 === 0
  ? { role: "user", content: `Request ${index}` }
  : { role: "assistant", content: [{ type: "text", text: `Answer ${index}` }] });
const historyIds = history.map((_, index) => `entry-${index}`);
const historyRows = buildChatHistoryRows(history, historyIds, false, new Set()).rows;
const historyOffsets = buildVirtualOffsets(historyRows.map((row) => row.key), new Map(), 160);
const taskTree = sessions.map((session) => ({ session, children: [] }));

const syntaxSources = ["components/DiffView.tsx", "components/FileViewer.tsx", "components/MermaidBlock.tsx", "components/LazySyntaxHighlighter.tsx"]
  .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
  .join("\n");
const appShellSource = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../hooks/useI18n.tsx", import.meta.url), "utf8");
const providerIconSource = readFileSync(new URL("../components/ModelProviderIcon.tsx", import.meta.url), "utf8");
const markdownSource = readFileSync(new URL("../lib/markdown.ts", import.meta.url), "utf8");
const markdownHookSource = readFileSync(new URL("../hooks/useMarkdownRehypePlugins.ts", import.meta.url), "utf8");
const markdownBodySource = readFileSync(new URL("../components/MarkdownBody.tsx", import.meta.url), "utf8");
const rootMarkdownConsumerSource = ["components/MessageView.tsx", "components/CollapsibleUserContent.tsx"]
  .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
  .join("\n");

const checks = [
  measure("filter 500 tasks", 50, () => filterSessions(sessions, "", "task 49")),
  measure("search a 5,000-file index", 800, () => filterFileEntries(fileEntries, "file-4999", 1_000)),
  measure("plan 10,000 actual chat rows", 100, () => buildChatHistoryRows(history, historyIds, false, new Set())),
  measure("window old, middle and recent chat positions", 10, () => [0, 800_000, 1_590_000].map((top) => virtualRange(historyOffsets, top, 900))),
  verify("chat windows stay bounded when navigating both directions", [0, 800_000, 1_590_000, 800_000, 0].every((top) => { const range = virtualRange(historyOffsets, top, 900); return range.end - range.start <= 20; })),
  measure("index and flatten 500 sidebar tasks", 50, () => flattenTaskWindow(indexTaskTree(taskTree, {}, []), new Set())),
  measure("bound the first 5,000-file tree render", 50, () => getTreeRenderWindow(5_000, TREE_INITIAL_RENDER_COUNT)),
  measure("bound the first 12,000-line diff render", 50, () => getDiffRenderWindow(12_000, DIFF_RENDER_BATCH)),
  measure("window a 10,000-change Review list", 50, () => getReviewListWindow(10_000, 9_999)),
  verify(
    "keep syntax highlighting languages and themes out of the initial bundle",
    syntaxSources.includes('react-syntax-highlighter/dist/esm/prism-light')
      && !syntaxSources.includes('prism-async-light')
      && !/^import (?!type\b).*from "react-syntax-highlighter";/m.test(syntaxSources)
      && !syntaxSources.includes('styles/prism"'),
  ),
  verify(
    "lazy-load secondary workspaces",
    appShellSource.includes('dynamic(() => import("./RoomWorkspace")')
      && appShellSource.includes('dynamic(() => import("./workspace/RightPanel")')
      && !appShellSource.includes('import { RoomWorkspace } from "./RoomWorkspace"')
      && !appShellSource.includes('import { RightPanel,'),
  ),
  verify(
    "lazy-load the non-default locale catalog",
    i18nSource.includes('import("@/lib/i18n/messages/en")')
      && !i18nSource.includes('from "@/lib/i18n/registry"'),
  ),
  verify(
    "lazy-load model provider glyphs",
    providerIconSource.includes('dynamic<IconProps>(() => import("@lobehub/icons/')
      && !/^import .*@lobehub\/icons/m.test(providerIconSource),
  ),
  verify(
    "lazy-load KaTeX for messages that contain math",
    !/^import .*rehype-katex/m.test(markdownSource)
      && markdownHookSource.includes('import("rehype-katex")'),
  ),
  verify(
    "lazy-load raw HTML parsing for messages that contain HTML",
    !/^import .*rehype-raw/m.test(markdownSource)
      && markdownHookSource.includes('import("rehype-raw")'),
  ),
  verify(
    "lazy-load code and Mermaid renderers until a code block is visible",
    markdownBodySource.includes('import("./MermaidBlock")')
      && !/^import .* from "\.\/MermaidBlock";/m.test(markdownBodySource),
  ),
  verify(
    "keep the full Markdown parser out of the empty application shell",
    rootMarkdownConsumerSource.includes('from "./LazyMarkdownBody"')
      && !/^import .* from "\.\/MarkdownBody";/m.test(rootMarkdownConsumerSource),
  ),
];

if (checks.some((passed) => !passed)) process.exitCode = 1;
