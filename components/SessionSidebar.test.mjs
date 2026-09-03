import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const taskRowSource = await readFile(new URL("./sidebar/TaskRow.tsx", import.meta.url), "utf8");
const taskStatusSource = await readFile(new URL("../hooks/useTaskStatus.ts", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebarStyles = await readFile(new URL("./SessionSidebar.module.css", import.meta.url), "utf8");
const splitSources = await Promise.all([
  "ProjectList.tsx", "SidebarNavigation.tsx", "SidebarProjectArea.tsx", "SidebarFileArea.tsx",
  "SidebarChatArea.tsx",
  "useSessionCatalog.ts", "sidebar-utils.ts", "sidebar-types.ts", "useProjectPicker.ts", "WorktreeSection.tsx",
].map((file) => readFile(new URL(`./sidebar/${file}`, import.meta.url), "utf8")));
const source = [mainSource, taskRowSource, ...splitSources].join("\n");
const sessionItemSource = taskRowSource.slice(taskRowSource.indexOf("export const TaskRow = memo(function TaskRow("));
const sidebarSource = source;

test("empty sessions use a friendly localized title instead of an internal placeholder", () => {
  assert.match(taskRowSource, /t\("sidebar\.newConversation"\)/);
  assert.doesNotMatch(taskRowSource, /\(no messages\)/);
});

test("always confirms session deletion and offers undo (no Shift+click bypass)", () => {
  // Task T-01: Shift+click no longer skips the confirmation — every delete
  // goes through the confirm state first, and deletion stays reversible.
  assert.doesNotMatch(sidebarSource, /e\.shiftKey/);
  assert.match(taskRowSource, /const handleDeleteClick[\s\S]*?setConfirmDelete\(true\);/);
  assert.match(taskRowSource, /const handleDeleteConfirm[\s\S]*?void performDelete\(\);/);
  assert.match(source, /const handleUndoDelete[\s\S]*?\/restore/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("streams running sessions and polls only as an SSE fallback", () => {
  assert.doesNotMatch(source, /fetch\("\/api\/agent\/running"/);
  assert.match(taskStatusSource, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(taskStatusSource, /eventSource\.onerror = scheduleFallbackPoll/);
  assert.match(taskStatusSource, /eventSource\.onopen = stopFallbackPoll/);
  assert.match(taskStatusSource, /document\.visibilityState !== "visible"/);
  assert.match(taskStatusSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
});

test("settles the project loading state when a background refresh supersedes the initial request", () => {
  assert.match(source, /if \(loadSessionsRequestIdRef\.current === requestId\) setLoading\(false\)/);
  assert.doesNotMatch(source, /if \(showLoading && loadSessionsRequestIdRef\.current === requestId\) setLoading\(false\)/);
  assert.match(globalStyles, /\.sidebar-project-scroll\s*\{[^}]*background:\s*inherit/s);
});

test("switches sessions immediately while another session is running", () => {
  const switchSource = source.slice(
    source.indexOf("const handleSelectSessionFromList"),
    source.indexOf("const handleNewSessionInProject"),
  );
  assert.doesNotMatch(switchSource, /window\.confirm/);
  assert.match(switchSource, /setSelectedCwd\(s\.projectless \? null : s\.cwd \|\| null\)/);
  assert.match(switchSource, /onSelectSession\(s\)/);
});

test("hover actions overlay a fixed-height session row without reflow", () => {
  assert.match(sessionItemSource, /position:\s*"relative"/);
  assert.match(sessionItemSource, /position:\s*"absolute"/);
  assert.match(sessionItemSource, /opacity:\s*hovered \? 1 : 0/);
  assert.doesNotMatch(sessionItemSource, /data-pinned-actions/);
  assert.match(source, /className=\{`sidebar-project-scroll \$\{styles\.projectScroll\}`\}/);
});

test("selected sessions use a neutral Codex-style background without an accent rail", () => {
  const selectedStyles = globalStyles.slice(
    globalStyles.indexOf(".sidebar-session-row.is-selected"),
    globalStyles.indexOf("/* No press-down translate", globalStyles.indexOf(".sidebar-session-row.is-selected")),
  );
  assert.match(selectedStyles, /background:\s*var\(--bg-selected\)/);
  assert.match(selectedStyles, /box-shadow:\s*none/);
  assert.doesNotMatch(selectedStyles, /inset|var\(--accent\)/);
});

test("project headings stay transparent while selected sessions keep their fill", () => {
  const projectStyles = sidebarStyles.slice(
    sidebarStyles.indexOf(".projectRow"),
    sidebarStyles.indexOf(".projectMain"),
  );
  assert.match(projectStyles, /\.projectRowSelected\s*\{\s*background:\s*transparent/);
  assert.doesNotMatch(projectStyles, /\.projectRow:hover[\s\S]*?background:/);
  assert.match(globalStyles, /\.sidebar-project-row\.is-selected\s*\{[^}]*background:\s*transparent/s);
  assert.match(globalStyles, /\.sidebar-project-row:hover\s*\{[^}]*background:\s*transparent/s);
});

test("renders sessions inside persisted project folders", () => {
  assert.match(source, /buildSessionProjectGroups\(/);
  assert.match(source, /<ProjectSessionGroup/);
  assert.match(source, /piora:sidebar-collapsed-projects:v1/);
  assert.match(source, /piora:sidebar-expanded-project-sessions:v1/);
  assert.match(source, /piora:sidebar-pinned-projects:v1/);
  assert.match(source, /piora:sidebar-project-aliases:v1/);
  assert.match(source, /piora:sidebar-remembered-projects:v1/);
  assert.match(source, /piora:sidebar-hidden-projects:v1/);
  assert.match(source, /piora:sidebar-project-order:v1/);
});

test("keeps empty projects and lets stale renamed paths be removed from the list", () => {
  assert.match(source, /rememberProject\(cwd\)/);
  assert.match(source, /visibleRememberedProjects/);
  assert.match(source, /hiddenProjectRoots\.has\(session\.projectRoot \?\? session\.cwd\)/);
  assert.match(source, /const removeProject = useCallback/);
  assert.match(source, /onRemoveProject=\{\(\) => removeProject\(group\.projectRoot\)\}/);
  assert.match(source, /sidebar\.removeProjectDescription/);
});

test("matches the Codex project rail with real pin, metadata, edit, and new-chat actions", () => {
  assert.match(source, /styles\.brandRow/);
  assert.match(source, /styles\.primaryNav/);
  assert.match(source, /pinnedProjectGroups\.map/);
  assert.match(source, /function ProjectContextMenu/);
  assert.match(source, /\/api\/project-info\?cwd=/);
  assert.match(source, /sidebar\.projectTaskSummary/);
  assert.match(source, /onTogglePinned/);
  assert.match(source, /onRenameProject/);
  assert.match(source, /onNewSession/);
  assert.match(source, /sidebar\.openProjectInExplorer/);
  assert.match(source, /disabled=\{!window\.piDesktop\?\.openPath\}/);
  assert.match(source, /void openPath\(group\.projectRoot\)/);
  assert.match(source, /sidebar\.newSessionTitle[\s\S]{0,180}<AliIcon name="comment" size=\{14\}/);
  assert.match(sidebarStyles, /button\.menuItem:disabled\s*\{[^}]*cursor:\s*default;[^}]*opacity:\s*0\.45/s);
  assert.match(source, /styles\.pinnedUnpin/);
  assert.match(source, /togglePinnedProject\(group\.projectRoot\)/);
});

test("keeps projectless conversations in a project-aligned chat section", () => {
  assert.match(source, /activeSessions\.filter\(\(session\) => session\.projectless\)/);
  assert.match(source, /activeSessions\.filter\(\(session\) => !session\.projectless\)/);
  assert.match(source, /<SidebarChatArea/);
  assert.match(source, /sidebar\.chats/);
  assert.match(source, /styles\.sectionLabelActions/);
  assert.match(source, /name="plus"/);
  assert.match(sidebarStyles, /\.chatSection\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.doesNotMatch(sidebarStyles, /\.chatSection\s*\{[^}]*border-top:/s);
  assert.match(sidebarStyles, /\.chatSessionList\s*\{[^}]*padding:\s*4px 1px 8px/s);
});

test("project session overflow is accessible and attention-aware", () => {
  assert.match(source, /getVisibleSessionRoots\(orderedRoots, sessionsExpanded, attentionSessionIds\)/);
  assert.match(source, /applySessionOrder\(\s*group\.tree/);
  assert.match(source, /new Set<string>\(\[\.\.\.runningSessionIds, \.\.\.unreadSessionIds\]\)/);
  assert.match(source, /const projectOpen = !isCollapsed/);
  assert.match(source, /name=\{projectOpen \? "folder-open" : "folder"\}/);
  assert.match(sidebarSource, /sidebar-running-spinner/);
  assert.match(source, /aria-expanded=\{sessionsExpanded\}/);
  assert.match(source, /sidebar\.showMoreSessions/);
  assert.match(source, /sidebar\.showFewerSessions/);
  assert.match(source, /onSelectProject\(\); onToggleProject\(\);/);
});

test("project creation lives in the projects header without a duplicate list", () => {
  assert.match(source, /sidebar\.newProject/);
  assert.match(source, /sidebar\.useDefaultDirectory/);
  assert.doesNotMatch(source, /t\("sidebar\.openProject"\)/);
  assert.doesNotMatch(source, /visibleProjects\.map/);
  assert.doesNotMatch(source, /filteredSessions/);
  assert.match(source, /className=\{styles\.sectionLabelActions\}/);
  assert.match(sidebarStyles, /\.projectsHeaderToggle svg\s*\{[^}]*opacity:\s*0/s);
  assert.match(sidebarStyles, /\.projectsHeader:hover \.projectsHeaderToggle svg,[\s\S]*?\.projectsHeader:hover \.sectionLabelActions/);
});

test("toggles all visible project folders from the projects header", () => {
  assert.match(source, /const allProjectsCollapsed = projectGroups\.length > 0[\s\S]*?projectGroups\.every/);
  assert.match(source, /sidebar\.expandAllProjects/);
  assert.match(source, /sidebar\.collapseAllProjects/);
  assert.match(source, /const next = new Set\(previous\)[\s\S]*?next\.delete\(group\.key\)[\s\S]*?next\.add\(group\.key\)/);
  assert.match(source, /name="chevron-right"/);
  assert.match(source, /className=\{allProjectsCollapsed \? undefined : styles\.projectsHeaderChevronOpen\}/);
  assert.match(source, /aria-expanded=\{!allProjectsCollapsed\}/);
});

test("exposes the existing validated project picker to shell-level project actions", () => {
  assert.match(source, /export interface SessionSidebarHandle\s*\{\s*openProjectPicker:\s*\(\) => void;/);
  assert.match(source, /forwardRef<SessionSidebarHandle, Props>/);
  assert.match(source, /useImperativeHandle\(ref,[\s\S]*?openProjectPicker:\s*handleCustomPathClick/);
  assert.match(source, /handleCustomPathClick[\s\S]*?setCustomPathOpen\(true\)/);
  assert.match(source, /commitCustomPath[\s\S]*?fetch\("\/api\/cwd\/validate"/);
});

test("keeps the real worktree switcher without an inactive repo-root hint", () => {
  assert.match(source, /showWorktreeSwitcher/);
  assert.match(source, /sidebar\.switchWorktreeTitle/);
  assert.doesNotMatch(source, /inactiveWorktreeSelector/);
  assert.doesNotMatch(source, /sidebar\.openRepoRoot/);
});

test("uses a compact Codex-style Piora brand row without the old animated title", () => {
  assert.doesNotMatch(source, /PiWebTitle|useScramble|sidebar-title-row/);
  assert.match(source, /sidebar\.appMenu/);
  assert.match(source, /\{showWorktreeSwitcher && <div\s+className="sidebar-header"/);
  assert.doesNotMatch(source, /<span>Piora<\/span>[\s\S]{0,120}rotate\(90deg\)/);
});

test("keeps project navigation visible with one settings entry and no duplicate extension shortcuts", () => {
  assert.match(source, /styles\.projectsHeader/);
  assert.match(source, /onOpenSettings/);
  assert.doesNotMatch(source, /onOpenSkills|onOpenPlugins/);
  assert.doesNotMatch(source, /styles\.accountButton|styles\.footer|accountLabel/);
});

test("keeps the projects bar outside the clipped session scroller", () => {
  const headerIndex = source.indexOf("styles.projectsHeader");
  const scrollerIndex = source.indexOf("styles.projectScroll");
  assert.ok(headerIndex >= 0 && scrollerIndex > headerIndex);
  assert.match(sidebarStyles, /\.projectArea\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(sidebarStyles, /\.projectScroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  const headerStyles = sidebarStyles.slice(
    sidebarStyles.indexOf(".projectsHeader"),
    sidebarStyles.indexOf(".projectScroll"),
  );
  assert.doesNotMatch(headerStyles, /position:\s*sticky|backdrop-filter/);
});

test("lets the chat section follow project content instead of pinning it to the bottom", () => {
  assert.match(sidebarStyles, /\.projectArea\s*\{[^}]*flex:\s*0 1 auto/s);
  assert.match(sidebarStyles, /\.projectScroll\s*\{[^}]*flex:\s*0 1 auto/s);
});

test("uses a settings gear instead of the notification bell", () => {
  const settingsButton = source.slice(
    source.indexOf("onClick={onOpenSettings}"),
    source.indexOf("</button>", source.indexOf("onClick={onOpenSettings}")),
  );
  assert.match(settingsButton, /AliIcon name="setting"/);
  assert.doesNotMatch(settingsButton, /AliIcon name="notification"/);
});
