import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appShell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const workbench = readFileSync(new URL("./SessionHistoryWorkbench.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const exportRoute = readFileSync(new URL("../app/api/sessions/[id]/export/route.ts", import.meta.url), "utf8");

test("opens complete session history inside the current application window", () => {
  assert.match(appShell, /setHistoryDialogOpen\(true\)/);
  assert.match(appShell, /<SessionHistoryWorkbench/);
  assert.doesNotMatch(appShell, /window\.open\(/);
  assert.match(appShell, /visibility: historyDialogOpen[^\n]+"hidden"/);
  assert.match(appShell, /inert=\{historyDialogOpen/);
  assert.match(workbench, /data-history-workbench/);
  assert.doesNotMatch(workbench, /<iframe|createPortal\(/);
});

test("retains standalone HTML export while reading through the native workbench", () => {
  assert.match(workbench, /history.exportHtml/);
  assert.match(workbench, /history.exportJson/);
  assert.match(workbench, /history.exportMarkdown/);
  assert.match(workbench, /onClick=\{reload\}/);
  assert.match(exportRoute, /embed \? "frame-ancestors 'self'" : "frame-ancestors 'none'"/);
  assert.match(exportRoute, /pi-session-history:escape/);
});

test("reduces the conversation toolbar to progressive-disclosure actions", () => {
  assert.match(appShell, /className="conversation-toolbar-actions"/);
  assert.match(appShell, /conversationMenu\.title/);
  assert.match(appShell, /conversationMenu\.systemPromptDescription/);
  assert.doesNotMatch(appShell, /handleAutoName|conversationMenu\.generateTitleDescription/);
  assert.doesNotMatch(appShell, /topbar-auto-name|topbar-system-button|topbar-stats-control/);
  assert.doesNotMatch(globalStyles, /topbar-auto-name|topbar-system-button|topbar-stats-control/);
});
