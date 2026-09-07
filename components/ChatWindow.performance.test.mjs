import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const historySource = await readFile(new URL("./ChatHistory.tsx", import.meta.url), "utf8");
const virtualSource = await readFile(new URL("./VirtualList.tsx", import.meta.url), "utf8");
const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const scrollRailSource = await readFile(new URL("./ChatScrollRail.tsx", import.meta.url), "utf8");
const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const resizerSource = await readFile(new URL("../hooks/useResizablePanel.ts", import.meta.url), "utf8");

test("memoizes historical chat metadata away from streaming token renders", () => {
  assert.match(historySource, /ChatHistory = memo/);
  assert.match(historySource, /const metadata = useMemo/);
  assert.match(historySource, /\}, \[messages\]\);/);
  assert.match(source, /<ChatHistory/);
  assert.doesNotMatch(historySource, /streamState|streamingMessage/);
});

test("long chat rows use browser rendering containment", () => {
  assert.match(historySource, /chat-message-shell/);
  assert.match(historySource, /<VirtualList/);
  assert.match(virtualSource, /ResizeObserver/);
  assert.match(virtualSource, /indices\.map/);
});

test("search and timeline reveal bounded history windows", () => {
  assert.match(source, /historyRef\.current\?\.revealEntry/);
  assert.doesNotMatch(source, /setVisibleCount|messages\.length \* 2/);
  assert.match(historySource, /list\.current\?\.scrollToKey/);
});

test("uses a responsive conversation column with resize and scroll rails", () => {
  assert.match(source, /followDefaultWidth:\s*true/);
  assert.match(source, /const CHAT_COLUMN_LEFT_PADDING = 36/);
  assert.match(source, /const CHAT_SCROLL_RAIL_GAP = 10/);
  assert.match(source, /const CHAT_COLUMN_RIGHT_PADDING = CHAT_SCROLL_RAIL_WIDTH \+ CHAT_SCROLL_RAIL_GAP/);
  assert.match(source, /const CHAT_INPUT_RIGHT_PADDING = CHAT_MINIMAP_WIDTH \+ CHAT_COLUMN_RIGHT_PADDING/);
  assert.match(source, /surfaceWidth - CHAT_COLUMN_LEFT_PADDING - CHAT_INPUT_RIGHT_PADDING/);
  assert.match(source, /className="chat-column"/);
  assert.match(source, /chat-column-resize-handle is-left/);
  assert.match(source, /data-resize-growth-direction="left"/);
  assert.doesNotMatch(source, /chat-column-resize-handle is-right/);
  assert.match(source, /<ChatScrollRail/);
  assert.match(source, /id="chat-scroll-container"/);
  assert.doesNotMatch(source, /maxWidth:\s*820/);
  assert.match(inputSource, /className="composer-column"/);
  assert.doesNotMatch(inputSource, /maxWidth:\s*820/);
  assert.match(globalCss, /--chat-column-width, clamp\(820px, 72vw, 1180px\)/);
  assert.match(globalCss, /\.chat-column-resize-handle\.is-left\s*\{[\s\S]*?left:\s*max\(2px,/);
  assert.match(inputSource, /paddingLeft:\s*variant === "launcher" \? 0 : isMobile \? 16 : 36/);
  assert.match(globalCss, /\.chat-column-scroll-rail/);
  assert.match(globalCss, /\.chat-column-scroll-thumb/);
  assert.match(source, /className="chat-scroll-rail-layout"/);
  assert.match(source, /className="chat-column chat-scroll-rail-anchor"/);
  assert.match(globalCss, /\.chat-scroll-rail-layout\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(globalCss, /\.chat-column-scroll-rail\s*\{[^}]*right:\s*-24px/s);
  assert.match(globalCss, /\.chat-column-scroll-rail\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(globalCss, /\.chat-column-scroll-rail\s*\{[^}]*cursor:\s*default/s);
  assert.match(globalCss, /\.chat-column-scroll-thumb\s*\{[^}]*width:\s*6px[^}]*opacity:\s*0\.78/s);
  assert.match(scrollRailSource, /role="scrollbar"/);
  assert.match(scrollRailSource, /onPointerMove/);
  assert.match(scrollRailSource, /onWheel/);
  assert.match(scrollRailSource, /event\.key === "PageDown"/);
  assert.match(resizerSource, /drag\.growthDirection === "right"/);
  assert.match(resizerSource, /readGrowthDirection\(event\.currentTarget, growthDirection\)/);
});

test("replaces the native conversation scrollbar with the draggable scroll rail", () => {
  assert.match(source, /id="chat-scroll-container"[^>]*className="chat-scroll-container flex-1 overflow-y-auto pt-4"/);
  assert.match(globalCss, /\.chat-scroll-container\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(globalCss, /\.chat-scroll-container::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
});

test("manual scrolling keeps the jump-to-latest control visible and resumes live follow", () => {
  assert.match(source, /const shouldShow = liveOutputFollowPaused \|\| shouldShowScrollToBottom/);
  assert.match(source, /t\(liveOutputFollowPaused \? "chat\.resumeAutoScroll" : "chat\.scrollToBottom"\)/);
  assert.match(source, /onClick=\{jumpToBottom\}/);
  assert.match(source, /historyRef\.current\?\.cancelNavigation\(\)/);
});
