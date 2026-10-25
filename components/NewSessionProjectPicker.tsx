"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useI18n } from "@/hooks/useI18n";
import { useDefaultToolPermission } from "@/hooks/useDefaultToolPermission";
import type { AttachedFile } from "@/hooks/useAgentSession";
import { fetchModelCatalog, type ModelCatalogEntry } from "@/lib/model-catalog-client";
import { buildSessionProjectGroups, getProjectLabel } from "@/lib/session-project-groups";
import type { SessionInfo } from "@/lib/types";
import type { SystemPromptSelection } from "@/lib/system-prompt-types";
import { AliIcon } from "./AliIcon";
import {
  ChatInput,
  type AttachedImage,
  type ChatInputHandle,
} from "./ChatInput";
import { DirectoryPicker } from "./DirectoryPicker";
import { NewSessionLauncher } from "./NewSessionLauncher";
import type { NewSessionLaunch } from "./new-session-types";
import styles from "./NewSessionProjectPicker.module.css";
import { SystemPromptSelector } from "./SystemPromptSelector";
import { savePendingPrompt } from "@/lib/prompt-recovery";
import type { ChatInputOptions } from "@/lib/chat-command-types";
import { persistentChatInputOptions } from "@/lib/chat-command-input";

interface ProjectChoice {
  root: string;
  cwd: string;
  sessionCount: number;
  latestModified: string | null;
}

function createLaunchId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function NewSessionProjectPicker({
  activeCwd,
  activeProjectRoot,
  chatInputRef,
  onLaunch,
  onProjectSelected,
  projectPickerRequestKey = 0,
}: {
  activeCwd?: string | null;
  activeProjectRoot?: string | null;
  chatInputRef?: RefObject<ChatInputHandle | null>;
  onLaunch: (request: NewSessionLaunch) => void;
  onProjectSelected?: (cwd: string | null) => void;
  projectPickerRequestKey?: number;
}) {
  const { t } = useI18n();
  const { state: toolPermission, saving: permissionSaving, savingRef: permissionSavingRef, error: permissionError, save: handleToolPermission } = useDefaultToolPermission();
  const localChatInputRef = useRef<ChatInputHandle>(null);
  const effectiveChatInputRef = chatInputRef ?? localChatInputRef;
  const draftKey = useRef(`new-task:${createLaunchId()}`).current;
  const projectControlRef = useRef<HTMLDivElement>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsReloadKey, setModelsReloadKey] = useState(0);
  const [loadedModelCwd, setLoadedModelCwd] = useState<string | null | undefined>(undefined);
  const [projectlessCwd, setProjectlessCwd] = useState<string | null>(null);
  const [projectlessError, setProjectlessError] = useState<string | null>(null);
  const [projectlessReloadKey, setProjectlessReloadKey] = useState(0);
  const [selectedProject, setSelectedProject] = useState<ProjectChoice | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [projectValidating, setProjectValidating] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [systemPromptSelection, setSystemPromptSelection] = useState<SystemPromptSelection>({ mode: "default" });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/sessions", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { sessions?: SessionInfo[] };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!cancelled) setSessions(data.sessions ?? []);
      })
      .catch(() => { /* An empty recent-project list is still usable. */ })
      .finally(() => { if (!cancelled) setSessionsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setProjectlessCwd(null);
    setProjectlessError(null);
    void fetch("/api/chat-workspace", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setProjectlessCwd(data.cwd);
      })
      .catch((error) => {
        if (controller.signal.aborted || cancelled) return;
        setProjectlessError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; controller.abort(); };
  }, [projectlessReloadKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const requestCwd = selectedProject?.cwd;
    setModelsLoading(true);
    setModelsError(null);
    setLoadedModelCwd(undefined);
    void fetchModelCatalog({
      cwd: requestCwd,
      forceRefresh: modelsReloadKey > 0,
      signal: controller.signal,
    })
      .then((data) => {
        if (cancelled) return;
        const nextModels = data.modelList ?? [];
        setModels(nextModels);
        setModelsError(data.modelError ?? null);
        setSelectedModelKey((current) => {
          if (nextModels.some((model) => `${model.provider}/${model.id}` === current)) return current;
          const preferred = data.defaultModel
            ? `${data.defaultModel.provider}/${data.defaultModel.modelId}`
            : "";
          if (preferred && nextModels.some((model) => `${model.provider}/${model.id}` === preferred)) return preferred;
          const first = nextModels[0];
          return first ? `${first.provider}/${first.id}` : "";
        });
        setLoadedModelCwd(requestCwd ?? null);
      })
      .catch((error) => {
        if (controller.signal.aborted || cancelled) return;
        setModels([]);
        setSelectedModelKey("");
        setModelsError(error instanceof Error ? error.message : String(error));
        setLoadedModelCwd(requestCwd ?? null);
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [modelsReloadKey, selectedProject?.cwd]);

  const projects = useMemo<ProjectChoice[]>(() => {
    const groups = buildSessionProjectGroups(
      sessions.filter((session) => !session.projectless),
      activeCwd ? { cwd: activeCwd, projectRoot: activeProjectRoot } : null,
    );
    return groups.map((group) => ({
      root: group.projectRoot,
      cwd: group.preferredCwd,
      sessionCount: group.sessions.length,
      latestModified: group.latestModified,
    }));
  }, [activeCwd, activeProjectRoot, sessions]);

  const filteredProjects = useMemo(() => {
    const needle = projectQuery.trim().toLocaleLowerCase();
    return projects
      .filter((project) => !needle
        || getProjectLabel(project.root).toLocaleLowerCase().includes(needle)
        || project.root.toLocaleLowerCase().includes(needle))
      .sort((left, right) => {
        const leftSelected = left.root === selectedProject?.root ? 1 : 0;
        const rightSelected = right.root === selectedProject?.root ? 1 : 0;
        return rightSelected - leftSelected
          || (right.latestModified ?? "").localeCompare(left.latestModified ?? "");
      });
  }, [projectQuery, projects, selectedProject?.root]);

  const selectedModel = useMemo(() => {
    const match = models.find((model) => `${model.provider}/${model.id}` === selectedModelKey);
    return match ? { provider: match.provider, modelId: match.id } : null;
  }, [models, selectedModelKey]);

  const launchReady = Boolean(
    selectedModel
    && !modelsLoading
    && loadedModelCwd === (selectedProject?.cwd ?? null)
    && (selectedProject || projectlessCwd),
  );

  const closeProjectMenu = useCallback(() => {
    setProjectMenuOpen(false);
  }, []);

  useEffect(() => {
    if (projectPickerRequestKey <= 0) return;
    setProjectMenuOpen(true);
  }, [projectPickerRequestKey]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const frame = window.requestAnimationFrame(() => projectSearchRef.current?.focus());
    const closeOnPointer = (event: PointerEvent) => {
      if (!projectControlRef.current?.contains(event.target as Node)) closeProjectMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeProjectMenu();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeProjectMenu, projectMenuOpen]);

  const chooseProjectless = useCallback(() => {
    setSelectedProject(null);
    onProjectSelected?.(null);
    setProjectError(null);
    setProjectMenuOpen(false);
    setProjectQuery("");
    window.requestAnimationFrame(() => effectiveChatInputRef.current?.focus());
  }, [effectiveChatInputRef, onProjectSelected]);

  const chooseProject = useCallback((project: ProjectChoice) => {
    setSelectedProject(project);
    onProjectSelected?.(project.cwd);
    setProjectError(null);
    setProjectMenuOpen(false);
    setProjectQuery("");
    window.requestAnimationFrame(() => effectiveChatInputRef.current?.focus());
  }, [effectiveChatInputRef, onProjectSelected]);

  const validateAndChooseProject = useCallback(async (candidate: string) => {
    if (projectValidating) return;
    setProjectValidating(true);
    setProjectError(null);
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: candidate }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!response.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${response.status}`);
      chooseProject({ root: data.cwd, cwd: data.cwd, sessionCount: 0, latestModified: null });
      setDirectoryPickerOpen(false);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectValidating(false);
    }
  }, [chooseProject, projectValidating]);

  const browseForProject = useCallback(async () => {
    setProjectMenuOpen(false);
    setProjectError(null);
    const selectDirectory = window.piDesktop?.selectDirectory;
    if (!selectDirectory) {
      setDirectoryPickerOpen(true);
      return;
    }
    try {
      const selected = await selectDirectory();
      if (selected) await validateAndChooseProject(selected);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    }
  }, [validateAndChooseProject]);

  const handleLandingSend = useCallback(async (
    message: string,
    images?: AttachedImage[],
    files?: AttachedFile[],
    onDurable?: (clientPromptId?: string) => void,
    retryOfPromptIds?: string[],
    commandInput?: ChatInputOptions,
  ): Promise<boolean> => {
    if (permissionSavingRef.current) return false;
    const cwd = selectedProject?.cwd ?? projectlessCwd;
    const commandSubmission = commandInput?.inputMode !== "text" && message.trimStart().startsWith("/");
    if (!cwd || !commandSubmission && (!selectedModel || !launchReady)) return false;
    const id = createLaunchId();
    const shell = !images?.length && !files?.length && message.trimStart().startsWith("!");
    if (!shell) {
      const draft = { value: message, images: (images ?? []).map(({ data, mimeType }) => ({ data, mimeType })), files: (files ?? []).map(file => ({ ...file })), commandInput: persistentChatInputOptions(commandInput), ...(retryOfPromptIds?.length ? { retryOfPromptIds } : {}) };
      await savePendingPrompt({ id, scope: `new:${cwd}`, draft, message: { role: "user", content: message, timestamp: Date.now(), clientPromptId: id, ...(commandSubmission ? { commandSubmission: true } : {}), recoveryDraft: draft } });
      onDurable?.(id);
    }
    onLaunch({
      cwd,
      projectRoot: selectedProject?.root ?? null,
      model: selectedModel ?? undefined,
      prompt: {
        id,
        message,
        images,
        files,
        systemPromptSelection,
        permissionMode: toolPermission?.mode,
        commandInput: { ...persistentChatInputOptions(commandInput), ...(!shell ? { submissionId: id } : {}) },
        retryOfPromptIds,
      },
    });
    return true;
  }, [launchReady, onLaunch, projectlessCwd, selectedModel, selectedProject, systemPromptSelection, toolPermission, permissionSavingRef]);

  const modelsUnavailable = !modelsLoading && models.length === 0;
  const modelSelectionBlocked = modelsLoading
    || !selectedModel
    || (selectedProject ? loadedModelCwd !== selectedProject.cwd : loadedModelCwd !== null || !projectlessCwd);

  const projectControl = (
    <div ref={projectControlRef} className={styles.projectControl}>
      <button
        type="button"
        className={styles.projectTrigger}
        onClick={() => setProjectMenuOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={projectMenuOpen}
        title={selectedProject?.root ?? t("newSession.chooseProject")}
      >
        <AliIcon name="folder" size={14} />
        <span>{selectedProject ? getProjectLabel(selectedProject.root) : t("newSession.chooseProject")}</span>
        <AliIcon name="arrowdown" size={10} />
      </button>
      {projectMenuOpen ? (
        <>
          <button
            type="button"
            className={styles.projectBackdrop}
            aria-label={t("chat.close")}
            tabIndex={-1}
            onClick={closeProjectMenu}
          />
          <div className={styles.projectPopover}>
            <label className={styles.projectSearch}>
              <AliIcon name="search" size={14} />
              <input
                ref={projectSearchRef}
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder={t("newSession.searchProjects")}
                aria-label={t("newSession.searchProjects")}
              />
            </label>
            <div className={styles.projectList} role="listbox" aria-label={t("newSession.chooseProject")}>
              <button
                type="button"
                role="option"
                aria-selected={!selectedProject}
                onClick={chooseProjectless}
              >
                <AliIcon name="message" size={15} />
                <span>
                  <strong>{t("newSession.projectless")}</strong>
                  <small>{t("newSession.projectlessDescription")}</small>
                </span>
              </button>
              {filteredProjects.map((project) => (
                <button
                  key={project.root}
                  type="button"
                  role="option"
                  aria-selected={project.root === selectedProject?.root}
                  onClick={() => chooseProject(project)}
                  title={project.root}
                >
                  <AliIcon name="folder" size={15} />
                  <span>
                    <strong>{getProjectLabel(project.root)}</strong>
                    <small>{project.root}</small>
                  </span>
                  {project.sessionCount > 0 ? <em>{project.sessionCount}</em> : null}
                </button>
              ))}
              {sessionsLoading ? <p>{t("newSession.loadingProjects")}</p> : null}
              {!sessionsLoading && filteredProjects.length === 0 ? <p>{t("newSession.noProjects")}</p> : null}
            </div>
            <button type="button" className={styles.browseProject} onClick={() => void browseForProject()}>
              <AliIcon name="folder-open" size={14} />
              {t("newSession.browseProject")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <NewSessionLauncher
        cwd={selectedProject?.cwd}
        projectLabel={selectedProject ? getProjectLabel(selectedProject.root) : null}
        onStarterSelect={(prompt) => effectiveChatInputRef.current?.insertIfEmpty(prompt)}
      >
        {permissionError && <p role="alert">{permissionError}</p>}
        <ChatInput
          ref={effectiveChatInputRef}
          variant="launcher"
          onSend={handleLandingSend}
          onAbort={() => {}}
          isStreaming={false}
          toolPermission={toolPermission}
          permissionSaving={permissionSaving}
          onToolPermissionChange={handleToolPermission}
          model={selectedModel}
          isAutoModelSelection={modelSelectionBlocked}
          modelList={models}
          modelError={models.length > 0 ? modelsError : null}
          onModelChange={async (provider, modelId) => {
            setSelectedModelKey(`${provider}/${modelId}`);
            return true;
          }}
          draftKey={draftKey}
          cwd={selectedProject?.cwd ?? null}
          placeholder={selectedProject ? t("newSession.placeholder") : t("newSession.placeholderWithoutProject")}
          contextControl={(
            <>
              {projectControl}
              <SystemPromptSelector
                selection={systemPromptSelection}
                onChange={setSystemPromptSelection}
              />
            </>
          )}
        />
        {(projectError || (!selectedProject && projectlessError) || modelsUnavailable) ? (
          <div className={styles.statusRow} role="alert">
            <span>{projectError ?? (!selectedProject ? projectlessError : null) ?? modelsError ?? t("newSession.modelsUnavailable")}</span>
            {!projectError && !selectedProject && projectlessError ? (
              <button type="button" onClick={() => setProjectlessReloadKey((key) => key + 1)}>
                <AliIcon name="reload" size={12} />
                {t("newSession.retryModels")}
              </button>
            ) : !projectError && modelsUnavailable ? (
              <button type="button" disabled={modelsLoading} onClick={() => setModelsReloadKey((key) => key + 1)}>
                <AliIcon name="reload" size={12} />
                {t("newSession.retryModels")}
              </button>
            ) : null}
          </div>
        ) : null}
      </NewSessionLauncher>
      {directoryPickerOpen ? (
        <DirectoryPicker
          busy={projectValidating}
          error={projectError}
          onCancel={() => {
            setDirectoryPickerOpen(false);
            setProjectError(null);
          }}
          onSelect={(path) => void validateAndChooseProject(path)}
        />
      ) : null}
    </>
  );
}
