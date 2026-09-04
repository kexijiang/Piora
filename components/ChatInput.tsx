"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { readPromptOptimizerModel, readPromptOptimizerSystemPrompt } from "@/lib/prompt-optimizer-settings";
import type { AttachedFile, BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import { clearDraft, getDraft, setDraft, type ChatDraftFile, type ChatDraftImage } from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGE_TOTAL_BYTES,
  MAX_ATTACHED_IMAGES,
  getBase64DecodedByteLength,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  LARGE_PASTE_CHARACTER_THRESHOLD,
  MAX_ATTACHED_FILE_BYTES,
  MAX_PROMPT_MATERIAL_COUNT,
  MAX_PROMPT_MATERIAL_BYTES,
  shouldMaterializeDirectPrompt,
} from "@/lib/prompt-input-policy";
import { ModelChangeCoordinator } from "@/lib/model-change-coordinator";
const MAX_ATTACHED_FILES = MAX_PROMPT_MATERIAL_COUNT;
const COMPOSER_MAX_HEIGHT = 360;
const IGNORED_NESTED_ATTACHMENT_DIRECTORIES = new Set([".git", ".next", "node_modules"]);

type BrowserAttachmentFile = Pick<File, "name"> & { webkitRelativePath?: string };

function normalizedAttachmentPath(file: BrowserAttachmentFile): string[] {
  return (file.webkitRelativePath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
}

export function getAttachmentFileName(file: BrowserAttachmentFile): string {
  const relativePath = normalizedAttachmentPath(file).join("/");
  return relativePath || file.name;
}

export function isFolderAttachmentFileAllowed(file: BrowserAttachmentFile): boolean {
  const pathSegments = normalizedAttachmentPath(file);
  // The first segment is the folder the user explicitly selected. Only skip
  // hidden/generated directories nested inside that explicit selection.
  return !pathSegments.slice(1, -1).some((segment) => (
    segment.startsWith(".") || IGNORED_NESTED_ATTACHMENT_DIRECTORIES.has(segment.toLocaleLowerCase())
  ));
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const viewportLimit = typeof window === "undefined" ? COMPOSER_MAX_HEIGHT : Math.round(window.innerHeight * 0.38);
  textarea.style.height = `${Math.min(textarea.scrollHeight, Math.max(200, Math.min(COMPOSER_MAX_HEIGHT, viewportLimit)))}px`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useLocalDictation } from "@/hooks/useLocalDictation";
import { useSendShortcut } from "@/hooks/useSendShortcut";
import { useStreamingSendPreference } from "@/hooks/useStreamingSendPreference";
import { prioritizeProvider } from "@/lib/model-policy";
import { isPlainEnter, matchesSendShortcut } from "@/lib/send-shortcut";
import { AliIcon } from "./AliIcon";
import { ModelProviderIcon } from "./ModelProviderIcon";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import type { ExtensionStatusItem } from "@/lib/types";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import {
  buildSlashCommandRegistry,
  filterSlashCommandRegistry,
  getSlashCommandDescription,
  type SlashCommandPaletteItem,
  type SlashCommandSource,
} from "@/lib/commands";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface PromptOptimizationState {
  source: string;
  loading: boolean;
  result?: string;
  error?: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => false | void | Promise<void>;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; contextWindow?: number }[];
  modelError?: string | null;
  onModelChange?: (provider: string, modelId: string) => Promise<boolean>;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  contextUsage?: ContextUsage | null;
  sessionStats?: SessionStatsInfo | null;
  extensionStatuses?: ExtensionStatusItem[];
  /** Reuses the production composer in a spacious new-task launch surface. */
  variant?: "conversation" | "launcher";
  placeholder?: string;
  /** Optional workspace/project control rendered beside the attachment button. */
  contextControl?: React.ReactNode;
}

export interface ChatInputHandle {
  focus: () => void;
  submit: () => void;
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  restoreFailedPrompt: (text: string, files?: AttachedFile[], images?: AttachedImage[]) => void;
  /** Send a separate local UI shortcut without replacing the user's draft. */
  sendText: (text: string) => boolean;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_FILTER_THRESHOLD = 8;

export function joinSpeechText(before: string, transcript: string, after: string, language: string): {
  value: string;
  selection: number;
} {
  const text = transcript.trim();
  if (!text) return { value: before + after, selection: before.length };

  // Mandarin dictation does not normally use spaces between phrases. For
  // space-delimited languages, keep dictated text readable when inserted at
  // the caret in the middle of an existing prompt.
  const usesWordSpaces = !language.toLocaleLowerCase().startsWith("zh");
  const leadingSpace = usesWordSpaces && before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailingSpace = usesWordSpaces && after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = leadingSpace + text + trailingSpace;
  return {
    value: before + inserted + after,
    selection: before.length + inserted.length - trailingSpace.length,
  };
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
type ModelMenuSection = "models" | "reasoning" | null;
const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};
const THINKING_LEVEL_LABEL_KEYS: Record<ThinkingLevel, string> = {
  auto: "chat.thinkingLevelAuto", off: "chat.thinkingLevelOff", minimal: "chat.thinkingLevelMinimal", low: "chat.thinkingLevelLow",
  medium: "chat.thinkingLevelMedium", high: "chat.thinkingLevelHigh", xhigh: "chat.thinkingLevelXhigh", max: "chat.thinkingLevelMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

export function getContextRemainingPercent(
  usage: { percent: number | null; contextWindow: number; tokens: number | null } | null | undefined,
): number | null {
  if (!usage || usage.contextWindow <= 0) return null;
  const usedPercent = usage.tokens !== null
    ? (usage.tokens / usage.contextWindow) * 100
    : usage.percent;
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};


function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

function attachedFileToDraftFile(file: AttachedFile): ChatDraftFile {
  return { ...file };
}

function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedFile[] {
  return (files ?? []).slice(0, MAX_ATTACHED_FILES).map((file) => ({ ...file }));
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  const { t } = useI18n();
  const isSteer = kind === "steer";

  return (
    <div className={`composer-queue-row ${isSteer ? "is-steer" : "is-follow-up"}`} title={text}>
      <span className="composer-queue-kind">
        <AliIcon name={isSteer ? "arrowright" : "arrowdown"} size={11} />
        {isSteer ? t("chat.steer") : t("chat.followUp")}
      </span>
      <span className="composer-queue-text">{text}</span>
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body }: { tone: "error" | "warning"; title: string; body: string }) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: "var(--text-xs)",
        lineHeight: 1.45,
      }}
    >
      <AliIcon name="warning" size={13} style={{ marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
    </div>
  );
}

export function ModelErrorBanner({ error, title = "模型错误" }: { error?: string | null; title?: string }) {
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={title} body={error} />;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, compactResult,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  contextUsage,
  sessionStats,
  extensionStatuses = [],
  variant = "conversation",
  placeholder,
  contextControl,
}: Props, ref) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const { shortcut: sendShortcut } = useSendShortcut();
  const { preference: streamingSendPreference } = useStreamingSendPreference();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [modelMenuSection, setModelMenuSection] = useState<ModelMenuSection>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [promptOptimization, setPromptOptimization] = useState<PromptOptimizationState | null>(null);
  const [streamingActionMenuOpen, setStreamingActionMenuOpen] = useState(false);
  const [streamingActionIndex, setStreamingActionIndex] = useState(0);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>(() => (
    draftKey ? draftFilesToAttachedFiles(getDraft(draftKey)?.files) : []
  ));
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isProcessingImages, setIsProcessingImages] = useState(false);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && attachedFiles.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);

  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<() => void>(() => {});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const streamingActionMenuRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const promptOptimizerAbortRef = useRef<AbortController | null>(null);
  const modelChangeCoordinatorRef = useRef<ModelChangeCoordinator | null>(null);
  if (!modelChangeCoordinatorRef.current) {
    modelChangeCoordinatorRef.current = new ModelChangeCoordinator();
  }
  const speechInsertionRef = useRef<{ before: string; after: string; language: string } | null>(null);
  const localVoiceStopRef = useRef<() => Promise<void>>(async () => {});
  const localVoiceCancelRef = useRef<() => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  const pendingImageBytesRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  const attachedFilesRef = useRef(attachedFiles);
  attachedFilesRef.current = attachedFiles;

  useEffect(() => {
    if (folderInputRef.current) folderInputRef.current.webkitdirectory = true;
  }, []);

  const stopVoiceInput = useCallback((abort = false) => {
    if (abort) localVoiceCancelRef.current();
    else void localVoiceStopRef.current();
    if (abort) speechInsertionRef.current = null;
  }, []);

  const processImageFiles = useCallback(async (files: File[]) => {
    if (isStreaming) return;
    setAttachmentError(null);
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    let remainingBytes = MAX_ATTACHED_IMAGE_TOTAL_BYTES
      - attachedImagesRef.current.reduce((total, image) => total + (getBase64DecodedByteLength(image.data) ?? 0), 0)
      - pendingImageBytesRef.current;
    let rejected = false;
    const imageFiles: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (imageFiles.length >= remaining || file.size > MAX_ATTACHED_IMAGE_BYTES || file.size > remainingBytes) {
        rejected = true;
        continue;
      }
      imageFiles.push(file);
      remainingBytes -= file.size;
    }
    if (rejected) setAttachmentError(t("chat.imageTooLarge", { size: "100 MB" }));
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    pendingImageBytesRef.current += imageFiles.reduce((total, file) => total + file.size, 0);
    setIsProcessingImages(true);
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        return [...prev, ...accepted];
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
      pendingImageBytesRef.current -= imageFiles.reduce((total, file) => total + file.size, 0);
      if (pendingImageCountRef.current <= 0) setIsProcessingImages(false);
    }
  }, [isStreaming, t]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
  }, []);

  const processFileSelection = useCallback(async (files: File[]) => {
    if (isStreaming) return;
    setAttachmentError(null);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) processImageFiles(imageFiles);

    const nonImageFiles = files.filter((file) => !file.type.startsWith("image/"));
    const remainingCount = Math.max(0, MAX_ATTACHED_FILES - attachedFilesRef.current.length);
    let remainingBytes = MAX_PROMPT_MATERIAL_BYTES - attachedFilesRef.current
      .filter((file) => file.text != null)
      .reduce((total, file) => total + file.size, 0);
    let rejectedForSize = false;
    let rejectedForCount = false;
    const textFiles: File[] = [];
    for (const file of nonImageFiles) {
      if (textFiles.length >= remainingCount) {
        rejectedForCount = true;
        continue;
      }
      if (file.size > MAX_ATTACHED_FILE_BYTES || file.size > remainingBytes) {
        rejectedForSize = true;
        continue;
      }
      textFiles.push(file);
      remainingBytes -= file.size;
    }
    if (rejectedForSize) {
      setAttachmentError(t("chat.attachmentTooLarge", { size: "100 MB" }));
    } else if (rejectedForCount) {
      setAttachmentError(t("chat.attachmentCountLimit", { count: MAX_ATTACHED_FILES }));
    }
    if (!textFiles.length) return;
    const prepared = await Promise.all(
      textFiles.map(async (file): Promise<AttachedFile> => {
        const name = getAttachmentFileName(file);
        try {
          const text = await file.text();
          if (text.includes("\u0000")) {
            return { name, size: file.size, text: null };
          }
          return { name, size: file.size, text };
        } catch {
          return { name, size: file.size, text: null };
        }
      }),
    );
    setAttachedFiles((prev) => [...prev, ...prepared].slice(0, MAX_ATTACHED_FILES));
  }, [isStreaming, processImageFiles, t]);

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus({ preventScroll: true });
    },
    submit() {
      submitRef.current();
    },
    sendText(text: string) {
      const message = text.trim();
      if (!message || isStreaming || isAutoModelSelection) return false;
      onSend(message);
      return true;
    },
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        resizeComposerTextarea(ta);
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((item) => item.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        resizeComposerTextarea(ta);
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((current) => current + (current ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const separator = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newValue = before + separator + text + after;
      setValue(newValue);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const position = start + separator.length + text.length;
        ta.setSelectionRange(position, position);
        ta.focus();
        resizeComposerTextarea(ta);
      });
    },
    addImages(files: File[]) {
      void processImageFiles(files);
    },
    addFiles(files: File[]) {
      void processFileSelection(files);
    },
    restoreFailedPrompt(text: string, files?: AttachedFile[], images?: AttachedImage[]) {
      setValue((current) => current.trim() ? [text, current].filter((item) => item.trim()).join("\n\n") : text);
      if (files?.length) setAttachedFiles((current) => [...files, ...current].slice(0, MAX_ATTACHED_FILES));
      if (images?.length) {
        setAttachedImages((current) => [
          ...images.map((image) => ({
            ...image,
            previewUrl: `data:${image.mimeType};base64,${image.data}`,
          })),
          ...current,
        ].slice(0, MAX_ATTACHED_IMAGES));
      }
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        resizeComposerTextarea(textarea);
      });
    },
  }));

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const restorePastedFile = useCallback((index: number) => {
    const file = attachedFilesRef.current[index];
    if (file?.kind !== "paste" || file.text == null) return;
    setAttachedFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setValue((current) => current ? `${current}\n\n${file.text}` : file.text!);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      resizeComposerTextarea(textarea);
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    stopVoiceInput(true);
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setStreamingActionMenuOpen(false);
    setAttachmentMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    setAttachedFiles([]);
    setAttachmentError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey, stopVoiceInput]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      files: attachedFiles.map(attachedFileToDraftFile),
    });
  }, [attachedFiles, attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    stopVoiceInput(true);

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        files: attachedFilesRef.current.map(attachedFileToDraftFile),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    promptOptimizerAbortRef.current?.abort();
    promptOptimizerAbortRef.current = null;
    setPromptOptimization(null);
    setAttachmentMenuOpen(false);
    setValue(draft?.value ?? "");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft?.images);
    });
    setAttachedFiles(draftFilesToAttachedFiles(draft?.files));
  }, [draftKey, stopVoiceInput]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) resizeComposerTextarea(ta);
  }, [value]);

  useEffect(() => {
    return () => {
      stopVoiceInput(true);
      promptOptimizerAbortRef.current?.abort();
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, [stopVoiceInput]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedFiles.length) return;
    if (isStreaming || isProcessingImages || isAutoModelSelection) return;
    if (!await modelChangeCoordinatorRef.current!.waitForIdle()) return;
    if (!attachedImages.length && !attachedFiles.length && msg.startsWith("/") && onBuiltinCommand) {
      const result = await onBuiltinCommand(msg);
      if (result.handled) {
        if (!result.error) clearInput();
        return;
      }
    }
    let messageToSend = msg;
    let filesToSend = attachedFiles;
    if (msg && shouldMaterializeDirectPrompt(msg, contextUsage)) {
      const existingPastes = attachedFiles.filter((file) => file.kind === "paste" && file.text != null);
      const combined = [msg, ...existingPastes.map((file) => file.text!)].join("\n\n");
      filesToSend = [
        ...attachedFiles.filter((file) => file.kind !== "paste"),
        {
          name: t("chat.pastedContentName", { count: 1 }),
          size: new TextEncoder().encode(combined).byteLength,
          text: combined,
          kind: "paste" as const,
        },
      ];
      messageToSend = "";
    }
    const accepted = onSend(
      messageToSend,
      attachedImages.length ? attachedImages : undefined,
      filesToSend.length ? filesToSend : undefined,
    );
    if (accepted === false) return;
    clearInput();
  }, [value, attachedImages, attachedFiles, isStreaming, isProcessingImages, isAutoModelSelection, onBuiltinCommand, onSend, clearInput, contextUsage, t]);

  useEffect(() => {
    submitRef.current = () => { void handleSend(); };
  }, [handleSend]);

  const handleOptimizePrompt = useCallback(async () => {
    const source = value.trim();
    const configuredModel = readPromptOptimizerModel(window.localStorage);
    const optimizerModel = configuredModel ?? (model ? { provider: model.provider, modelId: model.modelId } : null);
    if (!source || !optimizerModel || isAutoModelSelection || isStreaming || source.startsWith("/") || source.startsWith("!")) return;

    promptOptimizerAbortRef.current?.abort();
    const controller = new AbortController();
    promptOptimizerAbortRef.current = controller;
    setPromptOptimization({ source, loading: true });

    try {
      const response = await fetch("/api/prompts/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: source,
          provider: optimizerModel.provider,
          modelId: optimizerModel.modelId,
          cwd: cwd ?? undefined,
          systemPrompt: readPromptOptimizerSystemPrompt(window.localStorage),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { optimizedPrompt?: unknown; error?: unknown };
      if (!response.ok || typeof payload.optimizedPrompt !== "string" || !payload.optimizedPrompt.trim()) {
        const message = typeof payload.error === "string" ? payload.error : t("chat.optimizePromptFailed");
        throw new Error(message);
      }
      if (valueRef.current.trim() !== source) return;
      setPromptOptimization({ source, loading: false, result: payload.optimizedPrompt.trim() });
    } catch (error) {
      if (controller.signal.aborted || valueRef.current.trim() !== source) return;
      setPromptOptimization({
        source,
        loading: false,
        error: error instanceof Error ? error.message : t("chat.optimizePromptFailed"),
      });
    } finally {
      if (promptOptimizerAbortRef.current === controller) promptOptimizerAbortRef.current = null;
    }
  }, [cwd, isAutoModelSelection, isStreaming, model, t, value]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    return filterSlashCommandRegistry(buildSlashCommandRegistry(slashCommands ?? [], isStreaming), slashQuery, t);
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const canQueueStreamingMessage = hasInputText && attachedImages.length === 0 && attachedFiles.length === 0;
  const primaryStreamingMode = streamingSendPreference.enabled ? streamingSendPreference.behavior : "steer";
  const canSend = !isProcessingImages
    && !isAutoModelSelection
    && (hasInputText || attachedImages.length > 0 || attachedFiles.length > 0);
  const canOptimizePrompt = hasInputText
    && !isStreaming
    && !isAutoModelSelection
    && Boolean(model)
    && !trimmedValue.startsWith("/")
    && !trimmedValue.startsWith("!")
    && !promptOptimization?.loading;
  const queuedMessageCount = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);

  useEffect(() => {
    if (!isStreaming || !canQueueStreamingMessage || streamingSendPreference.enabled) {
      setStreamingActionMenuOpen(false);
    }
  }, [canQueueStreamingMessage, isStreaming, streamingSendPreference.enabled]);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const applyVoiceTranscript = useCallback((transcript: string) => {
    const insertion = speechInsertionRef.current;
    if (!insertion) return;
    const next = joinSpeechText(insertion.before, transcript, insertion.after, insertion.language);
    speechInsertionRef.current = null;
    setValue(next.value);
    updateAtQuery(next.value, next.selection);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(next.selection, next.selection);
      resizeComposerTextarea(element);
    });
  }, [updateAtQuery]);

  const prepareVoiceInsertion = useCallback(() => {
    const textarea = textareaRef.current;
    const currentValue = textarea?.value ?? valueRef.current;
    const selectionStart = textarea?.selectionStart ?? currentValue.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    speechInsertionRef.current = {
      before: currentValue.slice(0, selectionStart),
      after: currentValue.slice(selectionEnd),
      language: locale === "zh-CN" ? "zh-CN" : "en-US",
    };
    setHistoryMenuOpen(false);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    if (promptOptimization) {
      promptOptimizerAbortRef.current?.abort();
      promptOptimizerAbortRef.current = null;
      setPromptOptimization(null);
    }
  }, [locale, promptOptimization]);

  const localDictation = useLocalDictation({
    language: locale === "zh-CN" ? "zh" : "en",
    onTranscript: applyVoiceTranscript,
  });
  localVoiceStopRef.current = localDictation.stop;
  localVoiceCancelRef.current = localDictation.cancel;
  const localVoiceEnabled = localDictation.available && localDictation.supported;
  const localVoiceRecording = localVoiceEnabled
    && (localDictation.phase === "starting" || localDictation.phase === "recording");
  const voiceTranscribing = localVoiceEnabled && localDictation.phase === "transcribing";
  const voiceInputSupported = localVoiceEnabled;
  const voiceListening = localVoiceRecording;
  const effectiveVoiceError = localDictation.error;

  const toggleVoiceInput = useCallback(() => {
    if (!localVoiceEnabled) return;
    if (localDictation.phase === "idle") prepareVoiceInsertion();
    void localDictation.toggle();
  }, [localDictation, localVoiceEnabled, prepareVoiceInsertion]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      resizeComposerTextarea(el);
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      resizeComposerTextarea(ta);
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      resizeComposerTextarea(ta);
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!msg && !attachedImages.length) return;
    if (attachedImages.length) return;
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(msg, streamingBehavior, attachedImages.length ? attachedImages : undefined);
      clearInput();
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(msg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
    }
    clearInput();
  }, [value, attachedImages, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput]);

  const submitStreamingMessage = useCallback(() => {
    if (!canQueueStreamingMessage) return;
    if (streamingSendPreference.enabled) {
      sendQueued(streamingSendPreference.behavior);
      return;
    }
    setStreamingActionIndex(0);
    setStreamingActionMenuOpen(true);
  }, [canQueueStreamingMessage, sendQueued, streamingSendPreference]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || isPlainEnter(e)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || isPlainEnter(e)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || isPlainEnter(e)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      if (e.key === "Escape" && !isComposing && localVoiceRecording) {
        e.preventDefault();
        stopVoiceInput();
        return;
      }

      if (e.key === "Escape" && !isComposing && attachmentMenuOpen) {
        e.preventDefault();
        setAttachmentMenuOpen(false);
        return;
      }

      // Streaming action (steer / queue) menu — full keyboard navigation.
      if (streamingActionMenuOpen && canQueueStreamingMessage && !isComposing) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setStreamingActionIndex((index) => (index + 1) % 2);
          return;
        }
        if (isPlainEnter(e)) {
          e.preventDefault();
          sendQueued(streamingActionIndex === 0 ? "steer" : "followup");
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setStreamingActionMenuOpen(false);
          return;
        }
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (matchesSendShortcut(e, sendShortcut)) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          submitStreamingMessage();
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, canQueueStreamingMessage, stopVoiceInput, localVoiceRecording, attachmentMenuOpen, streamingActionMenuOpen, streamingActionIndex, sendQueued, sendShortcut, submitStreamingMessage]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeComposerTextarea(ta);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    if (pastedText.length <= LARGE_PASTE_CHARACTER_THRESHOLD || attachedFilesRef.current.length >= MAX_ATTACHED_FILES) return;
    e.preventDefault();
    const index = attachedFilesRef.current.filter((file) => file.kind === "paste").length + 1;
    setAttachedFiles((current) => [...current, {
      name: t("chat.pastedContentName", { count: index }),
      size: new TextEncoder().encode(pastedText).byteLength,
      text: pastedText,
      kind: "paste" as const,
    }].slice(0, MAX_ATTACHED_FILES));
  }, [processImageFiles, t]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return prioritizeProvider(
        modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })),
        (option) => option.provider,
      );
    }
    return prioritizeProvider(
      Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
        provider: model?.provider ?? "unknown",
        modelId,
        name,
      })),
      (option) => option.provider,
    );
  })();
  const filteredModelOptions = filterModelOptions(modelOptions, modelFilter);
  const showModelFilter = modelOptions.length > MODEL_FILTER_THRESHOLD;

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of filteredModelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model && !isAutoModelSelection
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;
  const activeThinkingLevel = (thinkingLevel ?? "auto") as ThinkingLevel;
  const thinkingLevelLabel = t(THINKING_LEVEL_LABEL_KEYS[activeThinkingLevel] ?? THINKING_LEVEL_LABEL_KEYS.auto);
  const contextRemainingPercent = getContextRemainingPercent(contextUsage);
  const contextUsedPercent = contextRemainingPercent === null ? null : 100 - contextRemainingPercent;
  const contextUsageLabel = contextUsedPercent === null
    ? t("chat.contextUsageUnknown")
    : t("chat.contextUsageLabel", { percent: Math.round(contextUsedPercent) });
  const contextTokenLabel = contextUsage?.tokens === null || !contextUsage?.contextWindow
    ? t("chat.contextTokensUnknown")
    : t("chat.contextTokensUsed", {
        used: formatTokenCount(contextUsage.tokens),
        total: formatTokenCount(contextUsage.contextWindow),
      });
  const contextBreakdownRows: [string, string][] | null = contextUsage?.breakdown ? [
    [t("chat.contextSystemPrompt"), formatTokenCount(contextUsage.breakdown.systemPrompt)],
    [t("chat.contextProjectInstructions"), formatTokenCount(contextUsage.breakdown.projectInstructions)],
    [t("chat.contextToolDefinitions"), formatTokenCount(contextUsage.breakdown.toolDefinitions)],
    [t("chat.contextConversationMessages"), formatTokenCount(contextUsage.breakdown.conversationMessages)],
    ...(contextUsage.breakdown.otherRuntime > 0
      ? [[t("chat.contextOtherRuntime"), formatTokenCount(contextUsage.breakdown.otherRuntime)] as [string, string]]
      : []),
  ] : null;
  const sessionMessageRows: [string, string][] = sessionStats ? [
    [t("session.user"), sessionStats.userMessages.toLocaleString(locale)],
    [t("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
    [t("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
    [t("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
  ] : [];
  const sessionTokenRows: [string, string][] = sessionStats ? [
    [t("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
    [t("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
    ...(sessionStats.tokens.cacheRead > 0
      ? [[t("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)] as [string, string]]
      : []),
    [t("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
  ] : [];

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
        setModelMenuSection(null);
        setModelFilter("");
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
      if (streamingActionMenuRef.current && !streamingActionMenuRef.current.contains(e.target as Node)) {
        setStreamingActionMenuOpen(false);
      }
      if (attachmentMenuRef.current && !attachmentMenuRef.current.contains(e.target as Node)) {
        setAttachmentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div
      data-composer-variant={variant}
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: variant === "launcher" ? 0 : "0 16px 8px",
        paddingLeft: variant === "launcher" ? 0 : isMobile ? 16 : 36, // reserve a safe gutter between selectable text and the left resize handle
        paddingRight: variant === "launcher" ? 0 : isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Native pickers stay outside the visible composer so files and folders
          remain separate, explicit choices in Chromium/Electron. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={isStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void processFileSelection(files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        disabled={isStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const selectedFiles = Array.from(e.target.files ?? []);
          const files = selectedFiles.filter(isFolderAttachmentFileAllowed);
          if (selectedFiles.length > 0 && files.length === 0) {
            setAttachmentError(t("chat.folderHasNoAttachableFiles"));
          } else {
            void processFileSelection(files);
          }
          e.target.value = "";
        }}
      />
      <div className="composer-column">
        <ModelErrorBanner error={modelError} title={t("chat.modelError")} />
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {queuedMessageCount > 0 && (
          <div className="composer-queue-tray" role="status" aria-label={t("chat.queued", { count: queuedMessageCount })}>
            <div className="composer-queue-list">
              {queuedMessages?.steering.map((text, i) => (
                <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
              ))}
              {queuedMessages?.followUp.map((text, i) => (
                <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
              ))}
            </div>
            {onRecallQueue && (
              <button
                type="button"
                className="composer-queue-recall"
                onClick={onRecallQueue}
                title={t("chat.recallTitle")}
                aria-label={t("chat.recall")}
              >
                <AliIcon name="history" size={13} />
              </button>
            )}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: "var(--text-sm)", color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AliIcon name="reload" size={11} />
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: "var(--text-sm)", color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AliIcon name="check" size={11} />
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            className="composer-surface"
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
            <span style={{ display: "block", marginTop: 4, fontFamily: "inherit", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
              {t("chat.compactErrorHint")}
            </span>
          </div>
        )}
        {/* Image previews */}
        {attachmentError && (
          <div role="alert" style={{ marginBottom: 6, color: "#ef4444", fontSize: "var(--text-xs)" }}>
            {attachmentError}
          </div>
        )}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <AliIcon name="close" size={8} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Attached non-image files */}
        {attachedFiles.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedFiles.map((file, i) => (
              <div
                key={`${file.name}:${i}`}
                title={file.text == null ? t("chat.attachedBinaryHint") : `${file.name} · ${formatFileSize(file.size)}`}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  maxWidth: 260, padding: "4px 6px 4px 8px",
                  background: "var(--bg-panel)", border: "1px solid var(--border)",
                  borderRadius: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)",
                }}
              >
                <AliIcon name="file" size={12} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                  {file.name}
                </span>
                {file.kind === "paste" && (
                  <button
                    type="button"
                    onClick={() => restorePastedFile(i)}
                    title={t("chat.restorePasteToComposer")}
                    aria-label={t("chat.restorePasteToComposer")}
                    style={{
                      flexShrink: 0, padding: "1px 4px", border: "none", borderRadius: 4,
                      background: "transparent", color: "var(--accent)", cursor: "pointer",
                      fontSize: "var(--text-xs)", whiteSpace: "nowrap",
                    }}
                  >
                    {t("chat.showInComposer")}
                  </button>
                )}
                <button
                  onClick={() => removeFile(i)}
                  title={t("chat.removeAttachment")}
                  aria-label={t("chat.removeAttachment")}
                  style={{
                    flexShrink: 0, width: 16, height: 16, padding: 0, border: "none", borderRadius: "50%",
                    background: "transparent", color: "var(--text-muted)", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <AliIcon name="close" size={8} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative" }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title="Input history"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <AliIcon name="history" size={14} />
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: "var(--text-sm)",
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div className="slash-command-menu" role="listbox" aria-label={t("chat.slashCommands", { label: slashCommandCountLabel })}>
              <div className="slash-command-menu-header">
                <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                <span className="slash-command-menu-hints" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> {t("chat.commandSwitch")} · <kbd>↵</kbd> {t("chat.commandRun")} · <kbd>esc</kbd> {t("chat.commandClose")}</span>
              </div>
              <div className="slash-command-menu-list">
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div className="slash-command-menu-empty">{t("chat.noCommands")}</div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} className="slash-command-group">
                      <div className="slash-command-group-header">
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span>{group.items.length}</span>
                      </div>
                      {group.items.map(({ command, index }) => {
                        const active = index === slashActiveIndex;
                        return (
                          <button
                            key={`${command.source}:${command.name}`}
                            ref={(node) => {
                              slashItemRefs.current[index] = node;
                            }}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className="slash-command-item"
                            data-active={active ? "true" : "false"}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              applySlashCommand(command);
                            }}
                            onMouseEnter={() => setSlashActiveIndex(index)}
                          >
                            <span className="slash-command-item-name">/{command.name}</span>
                            <span className="slash-command-item-desc">{getSlashCommandDescription(command, t)}</span>
                            <span className="slash-command-item-source">{t(SLASH_SOURCE_GROUP_LABEL_KEYS[command.source])}</span>
                          </button>
                        );
                      })}
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: "var(--text-xs)",
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: "var(--text-sm)", color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: "var(--text-sm)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          {promptOptimization && !promptOptimization.loading && (
            <div
              className={`prompt-optimization-review${promptOptimization.error ? " is-error" : ""}`}
              role={promptOptimization.error ? "alert" : "region"}
              aria-label={t("chat.optimizedPrompt")}
            >
              <div className="prompt-optimization-header">
                <span className="prompt-optimization-title">
                  <AliIcon name={promptOptimization.error ? "warning" : "solution"} size={14} />
                  {promptOptimization.error ? t("chat.optimizePromptFailed") : t("chat.optimizedPrompt")}
                </span>
                <div className="prompt-optimization-actions">
                  <button type="button" onClick={() => setPromptOptimization(null)}>
                    {t("chat.keepOriginalPrompt")}
                  </button>
                  {promptOptimization.result && (
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => {
                        setValue(promptOptimization.result!);
                        setPromptOptimization(null);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {t("chat.useOptimizedPrompt")}
                    </button>
                  )}
                </div>
              </div>
              <div className="prompt-optimization-content">
                {promptOptimization.error ?? promptOptimization.result}
              </div>
            </div>
          )}
          <div
            className="chat-composer-surface"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: "var(--radius-panel)",
              padding: "10px 10px 10px 14px",
              boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              if (localVoiceRecording || voiceTranscribing) stopVoiceInput(true);
              if (localDictation.error) localDictation.clearError();
              if (promptOptimization && e.target.value.trim() !== promptOptimization.source) {
                promptOptimizerAbortRef.current?.abort();
                promptOptimizerAbortRef.current = null;
                setPromptOptimization(null);
              }
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              placeholder ?? (isStreaming && (onSteer || onFollowUp)
                ? t("chat.steerPlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : t("chat.messagePlaceholder"))
            }
            rows={1}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-font-size)",
              lineHeight: "var(--chat-line-height)",
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: "min(38vh, 360px)",
              overflow: "auto",
            }}
          />

          {/* Composer footer: attach + model selector (bottom-right of the input) */}
          <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, marginTop: 6, minWidth: 0 }}>
            <div ref={attachmentMenuRef} className="composer-add-control">
              {attachmentMenuOpen && (
                <div className="composer-add-menu" role="menu" aria-label={t("chat.addMenu")}>
                  <div className="composer-add-menu-title">{t("chat.add")}</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-add-option"
                    onClick={() => {
                      setAttachmentMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <span className="composer-add-option-icon"><AliIcon name="attachment" size={15} /></span>
                    <span className="composer-add-option-copy">
                      <strong>{t("chat.attachFiles")}</strong>
                      <small>{t("chat.attachFilesDescription")}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-add-option"
                    onClick={() => {
                      setAttachmentMenuOpen(false);
                      folderInputRef.current?.click();
                    }}
                  >
                    <span className="composer-add-option-icon"><AliIcon name="folder-open" size={15} /></span>
                    <span className="composer-add-option-copy">
                      <strong>{t("chat.attachFolder")}</strong>
                      <small>{t("chat.attachFolderDescription")}</small>
                    </span>
                  </button>
                </div>
              )}
              <button
                type="button"
                className={`composer-add-trigger${attachmentMenuOpen ? " is-open" : ""}${attachedImages.length || attachedFiles.length ? " has-attachments" : ""}`}
                onClick={() => setAttachmentMenuOpen((open) => !open)}
                disabled={isStreaming}
                title={t("chat.add")}
                aria-label={t("chat.add")}
                aria-haspopup="menu"
                aria-expanded={attachmentMenuOpen}
              >
                <AliIcon name="plus" size={15} />
              </button>
            </div>
            {contextControl}
            {voiceInputSupported && (
              <>
                <button
                  type="button"
                  className={`voice-input-button${voiceListening ? " is-listening" : ""}${voiceTranscribing ? " is-transcribing" : ""}${effectiveVoiceError ? " is-error" : ""}`}
                  onClick={toggleVoiceInput}
                  disabled={voiceTranscribing}
                  aria-pressed={voiceListening}
                  aria-label={voiceListening ? t("chat.stopVoiceInput") : t("chat.startVoiceInput")}
                  title={voiceListening ? t("chat.stopVoiceInput") : t("chat.startVoiceInput")}
                >
                  <AliIcon name="microphone" size={15} />
                </button>
                {(voiceListening || voiceTranscribing || effectiveVoiceError) && (
                  <span
                    className={`voice-input-status${effectiveVoiceError ? " is-error" : ""}`}
                    role="status"
                    aria-live="polite"
                  >
                    {voiceListening
                      ? t("chat.voiceListening")
                      : voiceTranscribing
                        ? t("chat.voiceTranscribing")
                      : effectiveVoiceError === "permission"
                        ? t("chat.voicePermissionDenied")
                        : effectiveVoiceError === "microphone"
                          ? t("chat.voiceMicrophoneUnavailable")
                          : effectiveVoiceError === "no-speech"
                            ? t("chat.voiceNoSpeech")
                            : t("chat.voiceInputFailed")}
                  </span>
                )}
              </>
            )}
            <button
              type="button"
              className="prompt-optimize-button"
              onClick={() => void handleOptimizePrompt()}
              disabled={!canOptimizePrompt}
              data-loading={promptOptimization?.loading || undefined}
              title={!model ? t("chat.selectModelToOptimize") : t("chat.optimizePromptDescription")}
              aria-label={t("chat.optimizePrompt")}
            >
              <AliIcon name="solution" size={15} />
              {!isMobile && <span>{promptOptimization?.loading ? t("chat.optimizingPrompt") : t("chat.optimizePrompt")}</span>}
            </button>
            <div style={{ flex: 1 }} />
            {variant === "conversation" ? <ExtensionStatusBar statuses={extensionStatuses} /> : null}
            {variant === "conversation" ? <div className="session-stats-control">
              <div className="session-stats-trigger" tabIndex={0} aria-label={t("session.title")}>
                <AliIcon name="chart-no-axes-column" size={18} />
              </div>
              <div className="session-stats-tooltip" role="tooltip">
                <div className="session-stats-tooltip-title">{t("session.title")}</div>
                {sessionStats ? (
                  <div className="session-stats-tooltip-sections">
                    <div>
                      <div className="session-stats-tooltip-section-title">{t("session.messages")}</div>
                      <div className="session-stats-tooltip-grid">
                        {sessionMessageRows.map(([label, value]) => <React.Fragment key={`message:${label}`}><span>{label}</span><strong>{value}</strong></React.Fragment>)}
                      </div>
                    </div>
                    <div>
                      <div className="session-stats-tooltip-section-title">{t("session.tokens")}</div>
                      <div className="session-stats-tooltip-grid">
                        {sessionTokenRows.map(([label, value]) => <React.Fragment key={`token:${label}`}><span>{label}</span><strong>{value}</strong></React.Fragment>)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="session-stats-tooltip-empty">{t("session.load")}</div>
                )}
                {sessionStats && sessionStats.cost > 0 ? (
                  <div className="session-stats-tooltip-cost"><span>{t("session.cost")}</span><strong>${sessionStats.cost.toFixed(4)}</strong></div>
                ) : null}
              </div>
            </div> : null}
            {variant === "conversation" ? <div className="context-usage-control">
              <div
                className="context-usage-ring"
                tabIndex={0}
                aria-label={`${contextUsageLabel}. ${contextTokenLabel}`}
                data-context-used={contextUsedPercent?.toFixed(2) ?? "unknown"}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="8" pathLength="100" fill="none" stroke="color-mix(in srgb, var(--text-dim) 40%, transparent)" strokeWidth="2.4" />
                  {contextUsedPercent === null ? (
                    <circle cx="10" cy="10" r="8" pathLength="100" fill="none" stroke="var(--text-dim)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 6" transform="rotate(-90 10 10)" />
                  ) : (
                    <circle
                      cx="10" cy="10" r="8" pathLength="100" fill="none"
                      stroke={contextUsedPercent >= 90 ? "#ef4444" : contextUsedPercent >= 75 ? "#f59e0b" : "var(--text-muted)"}
                      strokeWidth="2.4" strokeLinecap="round"
                      strokeDasharray={`${contextUsedPercent} ${100 - contextUsedPercent}`}
                      transform="rotate(-90 10 10)"
                      style={{ transition: "stroke-dasharray 240ms ease, stroke 180ms ease" }}
                    />
                  )}
                </svg>
              </div>
              <div className="context-usage-tooltip" role="tooltip">
                <div className="context-usage-tooltip-heading">
                  <span>{t("chat.contextWindow")}:</span>
                  <span>{contextUsageLabel}</span>
                </div>
                <div className="context-usage-tooltip-value">{contextTokenLabel}</div>
                {contextBreakdownRows ? (
                  <div className="context-usage-breakdown">
                    <div className="context-usage-breakdown-title">{t("chat.contextBreakdownTitle")}</div>
                    {contextBreakdownRows.map(([label, value]) => (
                      <div className="context-usage-breakdown-row" key={label}>
                        <span>{label}</span>
                        <strong>≈ {value}</strong>
                      </div>
                    ))}
                    <div className="context-usage-tooltip-note">{t("chat.contextBreakdownNote")}</div>
                  </div>
                ) : <div className="context-usage-tooltip-note">{t("chat.contextIncludesSystemTools")}</div>}
              </div>
            </div> : null}
            {/* Codex-style model settings: one compact summary chip with focused submenus. */}
            {(modelOptions.length > 0 || currentName || modelError) && onModelChange && (
              <div ref={dropdownRef} className="model-settings-control">
                <button
                  type="button"
                  className={`model-settings-trigger${modelDropdownOpen ? " is-open" : ""}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setModelDropdownOpen((open) => {
                      if (!open) setModelMenuSection(null);
                      else {
                        setModelMenuSection(null);
                        setModelFilter("");
                      }
                      return !open;
                    });
                  }}
                  disabled={isStreaming}
                  aria-haspopup="menu"
                  aria-expanded={modelDropdownOpen}
                  title={modelOptions.length > 0 ? t("chat.selectModel") : t("chat.noModels")}
                >
                  <ModelProviderIcon provider={isAutoModelSelection ? undefined : model?.provider} modelId={isAutoModelSelection ? undefined : model?.modelId} modelName={currentName} size={14} />
                  <span className="model-settings-trigger-label">
                    {currentName ?? (modelOptions.length > 0 ? t("chat.selectModel") : t("chat.noModels"))}
                  </span>
                  {onThinkingLevelChange && !isAutoModelSelection ? <span className="model-settings-trigger-reasoning">{thinkingLevelLabel}</span> : null}
                </button>
                {modelDropdownOpen && modelDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
                  const bottom = viewportHeight - modelDropdownRect.top + 7;
                  const maxH = Math.max(160, Math.min(modelDropdownRect.top - 12, viewportHeight * 0.68));
                  const desktopPanelWidth = 230;
                  const desktopPanelLeft = Math.min(
                    Math.max(8, modelDropdownRect.left),
                    Math.max(8, viewportWidth - desktopPanelWidth - 8),
                  );
                  const submenuLeftSpace = desktopPanelLeft - 8;
                  const submenuRightSpace = viewportWidth - desktopPanelLeft - desktopPanelWidth - 8;
                  const submenuOpensRight = submenuRightSpace >= submenuLeftSpace;
                  const submenuWidth = Math.min(
                    292,
                    Math.max(160, (submenuOpensRight ? submenuRightSpace : submenuLeftSpace) - 7),
                  );
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                    : { left: desktopPanelLeft, right: "auto", width: desktopPanelWidth };
                  const visibleSection = isMobile ? modelMenuSection : null;
                  const selectableThinkingLevels = THINKING_LEVELS.filter((level) => (
                    !availableThinkingLevels || level === "auto" || availableThinkingLevels.includes(level)
                  ));
                  const renderModelChoices = () => (
                    <>
                      {showModelFilter ? (
                        <div className="model-settings-search">
                          <AliIcon name="search" size={13} />
                          <input
                            value={modelFilter}
                            onChange={(event) => setModelFilter(event.target.value)}
                            placeholder={t("chat.filterModels")}
                            aria-label={t("chat.filterModels")}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                      ) : null}
                      <div className="model-settings-list">
                        {modelsByProvider.length === 0 ? (
                          <div className="model-settings-empty">
                            {modelFilter.trim() ? t("chat.noMatchingModels") : t("chat.noModels")}
                          </div>
                        ) : modelsByProvider.map((group) => (
                          <div key={group.provider}>
                            {modelsByProvider.length > 1 ? <div className="model-settings-provider">{group.provider}</div> : null}
                            {group.options.map((option) => {
                              const isActive = !isAutoModelSelection && option.modelId === model?.modelId && option.provider === model?.provider;
                              return (
                                <button
                                  key={`${option.provider}:${option.modelId}`}
                                  type="button"
                                  className={`model-settings-choice${isActive ? " is-active" : ""}`}
                                  onClick={() => {
                                    setModelDropdownOpen(false);
                                    setModelMenuSection(null);
                                    setModelFilter("");
                                    if (!isActive || isAutoModelSelection) {
                                      modelChangeCoordinatorRef.current!.track(onModelChange(option.provider, option.modelId));
                                    }
                                  }}
                                  role="menuitemradio"
                                  aria-checked={isActive}
                                >
                                  <ModelProviderIcon className="model-settings-choice-icon" provider={option.provider} modelId={option.modelId} modelName={option.name} size={15} />
                                  <span className="model-settings-choice-label">{option.name}</span>
                                  {isActive ? <AliIcon name="check" size={11} /> : null}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </>
                  );
                  const renderReasoningChoices = () => (
                    <div className="model-settings-list">
                      {selectableThinkingLevels.map((level) => {
                        const isActive = activeThinkingLevel === level;
                        const mappedValue = level !== "auto" && thinkingLevelMap ? thinkingLevelMap[level] : undefined;
                        return (
                          <button
                            key={level}
                            type="button"
                            className={`model-settings-choice model-settings-reasoning-choice${isActive ? " is-active" : ""}`}
                            onClick={() => {
                              setModelDropdownOpen(false);
                              setModelMenuSection(null);
                              if (!isActive) onThinkingLevelChange?.(level);
                            }}
                            role="menuitemradio"
                            aria-checked={isActive}
                            title={t(THINKING_LEVEL_DESC_KEYS[level])}
                          >
                            <span>{t(THINKING_LEVEL_LABEL_KEYS[level])}</span>
                            {mappedValue != null && mappedValue !== level ? <small>{mappedValue}</small> : null}
                            {isActive ? <AliIcon name="check" size={11} /> : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                  return createPortal(
                    <div
                      ref={modelDropdownPanelRef}
                      className="model-settings-popover"
                      style={{ position: "fixed", bottom, maxHeight: maxH, ...panelPos }}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.stopPropagation();
                        if (modelMenuSection) setModelMenuSection(null);
                        else setModelDropdownOpen(false);
                      }}
                    >
                      {visibleSection ? (
                        <div className="model-settings-subview" role="menu">
                          <button type="button" className="model-settings-back" onClick={() => { setModelMenuSection(null); setModelFilter(""); }}>
                            <AliIcon name="arrowleft" size={13} />
                            <span>{visibleSection === "models" ? t("i18n.model") : t("chat.reasoningEffort")}</span>
                          </button>
                          {visibleSection === "models" ? renderModelChoices() : renderReasoningChoices()}
                        </div>
                      ) : (
                        <div className="model-settings-root" role="menu">
                          <button
                            type="button"
                            className={`model-settings-row${modelMenuSection === "models" ? " is-active" : ""}`}
                            onMouseEnter={() => { if (!isMobile) setModelMenuSection("models"); }}
                            onClick={() => setModelMenuSection("models")}
                            role="menuitem"
                          >
                            <span className="model-settings-row-label">{t("i18n.model")}</span>
                            <span className="model-settings-row-value">{currentName ?? t("chat.selectModel")}</span>
                          </button>
                          {onThinkingLevelChange && !isAutoModelSelection ? (
                            <button
                              type="button"
                              className={`model-settings-row${modelMenuSection === "reasoning" ? " is-active" : ""}`}
                              onMouseEnter={() => { if (!isMobile) setModelMenuSection("reasoning"); }}
                              onClick={() => setModelMenuSection("reasoning")}
                              role="menuitem"
                            >
                              <span className="model-settings-row-label">{t("chat.reasoningEffort")}</span>
                              <span className="model-settings-row-value">{thinkingLevelLabel}</span>
                            </button>
                          ) : null}
                          {!isStreaming && onCompact ? (
                            <div className="model-settings-footer">
                              {isCompacting ? (
                                <div className="model-settings-compaction" role="status" aria-live="polite">
                                  <span className="model-settings-compaction-spinner" aria-hidden="true" />
                                  <span className="model-settings-compaction-label">{t("chat.compacting")}</span>
                                  <button
                                    type="button"
                                    className="model-settings-compaction-stop"
                                    onClick={onAbortCompaction}
                                    title={t("chat.stopCompaction")}
                                    aria-label={t("chat.stopCompaction")}
                                  >
                                    <AliIcon name="stop" size={10} />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="model-settings-row"
                                  onClick={() => {
                                    setModelDropdownOpen(false);
                                    setModelMenuSection(null);
                                    onCompact();
                                  }}
                                  title={t("chat.compactContext")}
                                >
                                  <span>{t("chat.compactContext")}</span>
                                  <AliIcon name="shrink" size={12} />
                                </button>
                              )}
                            </div>
                          ) : null}
                          {!isMobile && modelMenuSection ? (
                            <div
                              className="model-settings-submenu"
                              role="menu"
                              style={{
                                maxHeight: maxH,
                                width: submenuWidth,
                                ...(submenuOpensRight
                                  ? { left: "calc(100% + 7px)", right: "auto" }
                                  : { right: "calc(100% + 7px)", left: "auto" }),
                              }}
                            >
                              <div className="model-settings-submenu-title">
                                {modelMenuSection === "models" ? t("i18n.model") : t("chat.reasoningEffort")}
                              </div>
                              {modelMenuSection === "models" ? renderModelChoices() : renderReasoningChoices()}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>,
                    document.body,
                  );
                })()}
              </div>
            )}
            {isStreaming ? (
              <div
                ref={streamingActionMenuRef}
                className="streaming-action-control"
                onKeyDown={(event) => {
                  if (!streamingActionMenuOpen || !canQueueStreamingMessage) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    event.stopPropagation();
                    setStreamingActionIndex((index) => (index + 1) % 2);
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    sendQueued(streamingActionIndex === 0 ? "steer" : "followup");
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setStreamingActionMenuOpen(false);
                    return;
                  }
                }}
              >
                {canQueueStreamingMessage && streamingActionMenuOpen && (
                  <div
                    className="streaming-action-menu"
                    role="menu"
                    aria-label={t("chat.chooseStreamingAction")}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="streaming-action-option is-steer"
                      data-active={streamingActionIndex === 0 ? "true" : "false"}
                      onMouseEnter={() => setStreamingActionIndex(0)}
                      onClick={() => sendQueued("steer")}
                    >
                      <span className="streaming-action-option-icon"><AliIcon name="arrowright" size={13} /></span>
                      <span className="streaming-action-option-copy">
                        <strong>{t("chat.steer")}</strong>
                        <small>{t("chat.steerDescription")}</small>
                      </span>
                    </button>
                    <div className="streaming-action-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="streaming-action-option"
                      data-active={streamingActionIndex === 1 ? "true" : "false"}
                      onMouseEnter={() => setStreamingActionIndex(1)}
                      onClick={() => sendQueued("followup")}
                    >
                      <span className="streaming-action-option-icon"><AliIcon name="arrowdown" size={13} /></span>
                      <span className="streaming-action-option-copy">
                        <strong>{t("chat.sendDirectly")}</strong>
                        <small>{t("chat.sendDirectlyDescription")}</small>
                      </span>
                    </button>
                    <div className="streaming-action-menu-hint" aria-hidden="true">
                      <span><kbd>↑</kbd><kbd>↓</kbd> {t("chat.commandSwitch")}</span>
                      <span><kbd>↵</kbd> {t("chat.commandRun")}</span>
                      <span><kbd>esc</kbd> {t("chat.commandClose")}</span>
                    </div>
                  </div>
                )}
                {canQueueStreamingMessage ? <div className="streaming-action-split">
                  <button
                    type="button"
                    className="streaming-action-primary"
                    onClick={() => sendQueued(primaryStreamingMode)}
                    title={t(primaryStreamingMode === "steer" ? "chat.steerDescription" : "chat.sendDirectlyDescription")}
                    aria-label={t(primaryStreamingMode === "steer" ? "chat.steer" : "chat.followUp")}
                  >
                    <AliIcon name="send" size={15} /><span>{t(primaryStreamingMode === "steer" ? "chat.steer" : "chat.followUp")}</span>
                  </button>
                  <button
                    type="button"
                    className="streaming-action-toggle"
                    onClick={() => { setStreamingActionIndex(0); setStreamingActionMenuOpen((open) => !open); }}
                    title={t("chat.chooseStreamingAction")}
                    aria-label={t("chat.chooseStreamingAction")}
                    aria-haspopup="menu"
                    aria-expanded={streamingActionMenuOpen}
                  >
                    <AliIcon name="arrowdown" size={11} />
                  </button>
                </div> : <button
                  type="button"
                  onClick={onAbort}
                  title={t("chat.stopAgent")}
                  aria-label={t("chat.stopAgent")}
                  className="streaming-stop-button"
                >
                  <AliIcon name="stop" size={15} />
                </button>}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                title={t(isProcessingImages ? "chat.processingImages" : isAutoModelSelection ? "chat.selectModel" : "chat.send")}
                aria-label={t(isProcessingImages ? "chat.processingImages" : isAutoModelSelection ? "chat.selectModel" : "chat.send")}
                style={{
                  width: 32, height: 32, padding: 0, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "none", borderRadius: "50%",
                  background: canSend ? "var(--text)" : "var(--bg-hover)",
                  color: canSend ? "var(--bg)" : "var(--text-dim)",
                  cursor: canSend ? "pointer" : "not-allowed",
                  transition: "background 120ms ease, color 120ms ease, transform 120ms ease",
                }}
              >
                <AliIcon name="send" size={16} />
              </button>
            )}
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")}{bashExcluded ? null : <> · {t("chat.outputModel")}</>}
          </div>
        )}
      </div>
    </div>
  );
});
