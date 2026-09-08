import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const picker = await readFile(new URL("./NewSessionProjectPicker.tsx", import.meta.url), "utf8");
const launcher = await readFile(new URL("./NewSessionLauncher.tsx", import.meta.url), "utf8");
const chatInput = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const launchTypes = await readFile(new URL("./new-session-types.ts", import.meta.url), "utf8");
const navigation = await readFile(new URL("./sidebar/SidebarNavigation.tsx", import.meta.url), "utf8");
const taskRow = await readFile(new URL("./sidebar/TaskRow.tsx", import.meta.url), "utf8");
const backgrounds = await readFile(new URL("../app/theme-backgrounds.css", import.meta.url), "utf8");
const sidebarCss = await readFile(new URL("./SessionSidebar.module.css", import.meta.url), "utf8");

test("new tasks start from one production composer with progressive context controls", () => {
  assert.match(shell, /const effectiveNewSessionCwd = newSessionCwd;/);
  assert.match(shell, /<NewSessionProjectPicker/);
  assert.match(navigation, /onRequestNewSession\(\)/);

  assert.match(picker, /<NewSessionLauncher/);
  assert.match(picker, /<ChatInput/);
  assert.match(picker, /variant="launcher"/);
  assert.match(picker, /contextControl=\{\([\s\S]*?\{projectControl\}[\s\S]*?<SystemPromptSelector/);
  assert.doesNotMatch(picker, /<textarea|<select|stepNumber|会话准备|准备好模型和项目/);
  assert.match(launcher, /t\("newSession\.title"\)/);
  assert.match(launcher, /<StarterCards/);

  assert.match(picker, /fetchModelCatalog\(\{/);
  assert.match(picker, /cwd: requestCwd/);
  assert.match(picker, /const preferred = data\.defaultModel/);
  assert.match(picker, /const first = nextModels\[0\]/);
  assert.match(picker, /buildSessionProjectGroups/);
  assert.match(picker, /sessions\.filter\(\(session\) => !session\.projectless\)/);
  assert.match(picker, /new-task:\$\{createLaunchId\(\)\}/);
});

test("global new-session actions open the project-selectable launcher", () => {
  const requestHandler = shell.slice(
    shell.indexOf("const handleRequestNewSession"),
    shell.indexOf("const handleNewSessionLaunch"),
  );
  assert.match(requestHandler, /setSelectedSession\(null\)/);
  assert.match(requestHandler, /setNewSessionCwd\(null\)/);
  assert.match(requestHandler, /setInitialSessionRestored\(true\)/);
  assert.doesNotMatch(requestHandler, /chat-workspace|handleNewSession/);
  assert.match(shell, /case "new-session":\s*handleRequestNewSession\(\)/);
  assert.match(shell, /<NewSessionProjectPicker[\s\S]*?activeCwd=\{activeCwd\}/);
  assert.match(navigation, /if \(onRequestNewSession\) \{\s*onRequestNewSession\(\)/);
});

test("new conversations default to projectless and keep workspace selection optional", () => {
  assert.match(chatInput, /const accepted = await onSend\(/);
  assert.match(chatInput, /if \(accepted === false\) return;[\s\S]*?clearInput\(\)/);
  assert.match(picker, /fetch\("\/api\/chat-workspace"/);
  assert.match(picker, /const \[selectedProject, setSelectedProject\] = useState<ProjectChoice \| null>\(null\)/);
  assert.match(picker, /const cwd = selectedProject\?\.cwd \?\? projectlessCwd/);
  assert.match(picker, /projectRoot: selectedProject\?\.root \?\? null/);
  assert.match(picker, /const chooseProjectless = useCallback/);
  assert.match(picker, /t\("newSession\.projectless"\)/);
  assert.doesNotMatch(picker, /setSubmitAfterProjectSelection|setProjectRequired/);
  assert.match(launchTypes, /projectRoot: string \| null/);
  assert.match(shell, /if \(request\.projectRoot\)[\s\S]*?setActiveCwd\(null\)/);
  assert.match(picker, /onLaunch\(\{[\s\S]*?prompt: \{[\s\S]*?message,[\s\S]*?images,[\s\S]*?files/);
  assert.match(picker, /systemPromptSelection/);
  assert.doesNotMatch(picker, /prompt: \{[\s\S]*?options/);

  assert.match(shell, /newSessionInitialPrompt/);
  assert.match(shell, /claimNewSessionInitialPrompt/);
  assert.match(shell, /lastClaimedInitialPromptRef/);
  assert.match(shell, /initialPrompt=\{newSessionInitialPrompt\}/);
  assert.match(chatWindow, /claimInitialPrompt\(initialPrompt\.id\)/);
  assert.match(chatWindow, /void handleSend\([\s\S]*?initialPrompt\.message,[\s\S]*?initialPrompt\.images,[\s\S]*?initialPrompt\.files/);
  assert.doesNotMatch(shell, /pendingLandingDraftRef|pendingLandingModelRef/);
  assert.match(picker, /const modelsUnavailable = !modelsLoading && models\.length === 0/);
  assert.match(picker, /projectError \|\| \(!selectedProject && projectlessError\) \|\| modelsUnavailable/);
  assert.match(picker, /modelError=\{models\.length > 0 \? modelsError : null\}/);
  assert.match(picker, /className=\{styles\.projectBackdrop\}/);
});

test("project browsing is selection-only and cancellation preserves projectless mode", async () => {
  const [preload, desktopMain] = await Promise.all([
    readFile(new URL("../desktop/src/preload.ts", import.meta.url), "utf8"),
    readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.match(picker, /window\.piDesktop\?\.selectDirectory/);
  assert.match(picker, /const selected = await selectDirectory\(\)/);
  assert.doesNotMatch(picker, /setSubmitAfterProjectSelection|pendingSubmissionClaimedRef/);
  assert.match(picker, /<DirectoryPicker/);
  assert.match(picker, /fetch\("\/api\/cwd\/validate"/);
  assert.doesNotMatch(picker, /onNewSession|pendingLanding|openProjectPicker/);
  assert.match(preload, /selectDirectory\(\)[\s\S]*pi:directory-picker/);
  assert.match(desktopMain, /DIRECTORY_PICKER_CHANNEL[\s\S]*showOpenDialog[\s\S]*openDirectory/);
});

test("new chat keeps the right workspace toggle available before project selection", () => {
  assert.match(shell, /!settingsDialogOpen && \(\s*<div className="conversation-toolbar-actions">/);
  assert.match(shell, /\{showChat \? \([\s\S]*topbar-changes-button[\s\S]*\) : null\}[\s\S]*right-panel-toggle/);
});

test("conversation chrome and rooms share the configured background", () => {
  assert.match(backgrounds, /data-app-background-active="true"\] \.app-topbar \{\s*background: transparent/s);
  assert.match(backgrounds, /\.room-workspace-header/);
  assert.match(backgrounds, /\.room-workspace-details/);
  assert.match(backgrounds, /data-app-background-active="true"\] \.sidebar-projects-header \{[\s\S]*?background: transparent/s);
  assert.match(sidebarCss, /\.chatSection \{[\s\S]*?background: transparent/);
});

test("pinned sessions use a passive badge and the dead brand search action is gone", () => {
  assert.match(taskRow, /title=\{t\("sidebar\.pinned"\)\}/);
  assert.match(taskRow, /name="pushpin"/);
  assert.doesNotMatch(taskRow, /data-pinned-actions/);
  const brandActions = navigation.match(/<div className=\{styles\.brandActions\}>([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.doesNotMatch(brandActions, /name="search"/);
  assert.match(brandActions, /name="setting"/);
});
